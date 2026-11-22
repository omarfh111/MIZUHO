"""Ground M9 turns in the active site's verified M3/M4 replay, M5 result and M8 corpus."""

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from pydantic import Field
from tools.m2m3.mizu_m2m3.solar import simulation_solar_profile

from .assistant_api import AssistantRuntime
from .assistant_memory import AssistantMemory
from .compare import compare, effective_scenario
from .evidence import search
from .models import AssistantCityPeriod, AssistantTelemetry, CompareRequest, Comparison, PlanningModel, RegionalPlanContext
from .providers import ServiceError
from .telemetry import known_site, replay
from .tunisia import ARCHIVE_DIR, Climate, get_city_analysis
from .zone_planning import compare_zone


class CallStart(PlanningModel):
    type: Literal["start"]
    site_id: Annotated[str, Field(min_length=1, max_length=120)] | None = None
    city_id: Annotated[str, Field(pattern=r"^\d{1,12}$")] | None = None
    city_period: AssistantCityPeriod | None = None
    reason: Literal["accessibility", "emergency", "clarification"]
    language: Literal["fr", "en", "ja", "aeb"] = "fr"
    comparison: CompareRequest | None = None
    telemetry: AssistantTelemetry | None = None
    zone_plan: RegionalPlanContext | None = None
    solar_option_id: Annotated[str, Field(min_length=1, max_length=120)] | None = None
    pvgis_option_id: Literal["ombriere", "toiture"] | None = None
    selected_scenario_id: Annotated[str, Field(min_length=1, max_length=120)] | None = None
    simulation_pending: bool = False


EVENTS = {
    "unexplained_water": ("Le bilan d’eau présente un écart inexpliqué. Pouvez-vous vérifier le compteur et le niveau de la cuve avant de conclure à une fuite ?", "The water balance shows an unexplained discrepancy. Can you check the meter and tank level before attributing it to a leak?", "水収支に原因不明の差があります。漏水と判断する前に、計器と貯水量を確認できますか。", "فمّا فرق في حساب الماء وما زلنا ما نعرفوش علاش. تنجّم تثبّت في العدّاد وفي مستوى الخزّان قبل ما نقولو فمّا تسرّب؟"),
    "high_pump_energy_intensity": ("L’énergie consommée par volume pompé dépasse la référence. Pouvez-vous vérifier le débit et le compteur électrique ?", "Energy per volume pumped exceeds the reference. Can you check flow and the electricity meter?", "揚水量あたりの電力量が基準を超えました。流量と電力量計を確認できますか。", "البومبة تستهلك في الضوّ أكثر من المعتاد على نفس كمّية الماء. تنجّم تثبّت في الدفْق وعدّاد الضوّ؟"),
    "grid_outage": ("Le réseau électrique est coupé. Pouvez-vous vérifier l’alimentation de la pompe ?", "Grid power is interrupted. Can you check the pump supply?", "停電が発生しました。ポンプの電源を確認できますか。", "الضوّ مقصوص. تنجّم تشوف كان البومبة واصلها الضوّ؟"),
    "tank_empty": ("La cuve est vide. Pouvez-vous vérifier le niveau avant la prochaine distribution ?", "The reservoir is empty. Can you check the level before the next delivery?", "貯水槽が空です。次の配水前に水位を確認できますか。", "الخزّان فارغ. تنجّم تثبّت في المستوى قبل دورة السقي الجاية؟"),
    "pump_shutdown": ("La pompe est indisponible. Pouvez-vous vérifier son état ?", "The pump is unavailable. Can you check its status?", "ポンプが使用できません。状態を確認できますか。", "البومبة واقفة. تنجّم تثبّت في حالتها؟"),
    "missing_flow": ("La mesure du débit manque. Que montre le compteur local ? Une absence de lecture ne signifie pas un débit nul.", "The flow reading is missing. What does the local meter show? A missing reading does not establish zero flow.", "流量計の値が欠測しています。現地の計器には何が表示されていますか。欠測は流量ゼロを意味しません。", "قراءة الدفْق ناقصة. شنوة يعطي العدّاد عندك؟ كي تغيب القراءة، ما ننجّموش نقولو اللي الماء واقف."),
}
PRIORITY = ("unexplained_water", "high_pump_energy_intensity", "pump_shutdown", "tank_empty", "grid_outage", "missing_flow")


@dataclass
class Dialogue:
    start: CallStart
    service: AssistantRuntime
    archive: Path = ARCHIVE_DIR
    site_label: str = ""
    climate: Climate | None = None
    frame: dict | None = None
    event: dict | None = None
    plan: Comparison | None = None
    observations: list[str] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)
    proposal: dict | None = None
    approval_failures: int = 0
    last_text: str = ""
    live_remainder: str | None = None
    last_language: str = ""
    presentation_brief: str = ""
    rag_session: UUID = field(default_factory=uuid4)
    rag_memory: AssistantMemory = field(default_factory=AssistantMemory)

    def say(self, fr: str, en: str, ja: str, aeb: str) -> str:
        return {"fr": fr, "en": en, "ja": ja, "aeb": aeb}[self.start.language]

    def open(self):
        ctx, catalog = self.start, self.service.catalog
        if ctx.simulation_pending and (ctx.comparison or ctx.telemetry or ctx.zone_plan):
            raise ValueError("Recalculate after changing simulation inputs")
        if ctx.selected_scenario_id:
            scenario = catalog.scenarios.get(ctx.selected_scenario_id)
            if (not scenario or scenario.site_id != ctx.site_id
                    or ctx.comparison and ctx.comparison.scenario_id != scenario.id):
                raise ValueError("Invalid selected scenario")
        if ctx.solar_option_id:
            solar = catalog.solar.get(ctx.site_id)
            if not solar or ctx.pvgis_option_id or not any(o.id == ctx.solar_option_id for o in solar.options):
                raise ValueError("Invalid solar option")
        if ctx.pvgis_option_id:
            simulation_solar_profile(ctx.site_id, ctx.pvgis_option_id)
        if ctx.zone_plan and (ctx.solar_option_id or ctx.pvgis_option_id or ctx.selected_scenario_id):
            raise ValueError("Conflicting regional context")
        if ctx.city_period and not ctx.city_id:
            raise ValueError("Choose a city before selecting a climate period")
        if not ctx.site_id:
            if ctx.reason != "accessibility" or ctx.comparison or ctx.telemetry or ctx.zone_plan or ctx.simulation_pending:
                raise ValueError("No registered station")
            if ctx.city_id:
                period = ctx.city_period
                city = get_city_analysis(ctx.city_id, self.archive, start=period.start if period else None,
                                         end=period.end if period else None)
                self.site_label, self.climate = city.city.name, city.climate
            else:
                self.site_label = self.say("Tunisie", "Tunisia", "チュニジア", "تونس")
            return self.site_summary()
        if ctx.city_id:
            raise ValueError("Conflicting locations")
        site = known_site(catalog, ctx.site_id)
        self.site_label = site.label
        if zone := catalog.field_zones.get(ctx.site_id):
            self.climate = zone.climate
        if ctx.comparison:
            scenario = catalog.scenarios.get(ctx.comparison.scenario_id)
            if not scenario or scenario.site_id != ctx.site_id or ctx.zone_plan:
                raise ValueError("context")
            effective_scenario(catalog, ctx.comparison)
        if ctx.zone_plan:
            profile = catalog.zone_planning.get(ctx.site_id)
            if profile is None:
                raise ValueError("context")
            checked = compare_zone(profile, ctx.zone_plan.inputs, self.service.solver_budget)
            if checked.comparison_id != ctx.zone_plan.comparison_id:
                raise ValueError("stale")
            self.plan = checked.comparison
        if ctx.telemetry:
            if not ctx.comparison or ctx.telemetry.selected_slot is None:
                raise ValueError("context")
            projection = replay(catalog, ctx.comparison, ctx.telemetry)
            slot = ctx.telemetry.selected_slot
            self.frame = next((f for f in projection["frames"] if f["slot"] == slot), None)
            if not self.frame:
                raise ValueError("slot")
            events = [*projection["alerts"], *projection["events"]]
            self.event = next((e for kind in PRIORITY for e in events
                               if e["simulation_slot"] == slot and e["type"] == kind), None)
        if ctx.reason == "emergency" and (self.event is None or self.event["type"] == "missing_flow"):
            raise ValueError("No critical event")
        if ctx.reason == "clarification" and ctx.telemetry and (not self.event or self.event["type"] != "missing_flow"):
            raise ValueError("No missing sensor reading at this replay hour")
        if ctx.reason == "clarification" and not (self.event or
                (site.survey_available and catalog.agriculture[ctx.site_id].quota_m3 is None) or
                (site.field_zone and not ctx.zone_plan)):
            raise ValueError("No clarification needed")
        if self.event or self.frame:
            return self.replay_summary()
        if ctx.reason == "clarification":
            return self.say(f"{site.label}. Quel volume votre autorisation permet-elle encore de prélever ?",
                            f"{site.label}. What withdrawal volume is still authorized?",
                            f"{site.label}。現在の取水許可量の残りを確認できますか。", f"في {site.label}، قدّاش مازال مسموحلك تسحب من الماء؟")
        return self.site_summary()

    def site_summary(self):
        if not self.start.site_id:
            return self.say(f"Atlas : {self.site_label}. Vous pouvez consulter les sources. Sélectionnez une station pour examiner une alerte ou un planning.",
                            f"Welcome! We're looking at {self.site_label}. I can walk you through the map, help you introduce it, or translate a phrase for your audience.",
                            f"{self.site_label}の地図へようこそ。地図の説明や発表の練習をしましょう。伝えたい言葉の翻訳もお手伝いします。",
                            f"عسلامة! توّا نشوفو في خريطة {self.site_label}. ننجّم نفسّرلك الخريطة، نعاونك تحضّر العرض، وإلا نترجملك جملة للحاضرين.")
        return self.say(f"Vous consultez {self.site_label}. Demandez-moi d’expliquer un graphique, un plan ou une source.",
                        f"Hi! We're at {self.site_label}. What would help you most: walking through this screen, practicing your introduction or translating a phrase?",
                        f"{self.site_label}を一緒に見てみましょう。画面の説明、発表の練習、伝えたい言葉の翻訳をお手伝いします。",
                        f"عسلامة! توّا إحنا في {self.site_label}. شنوة تحبّ نعملو مع بعضنا؟ نفسّرلك الشاشة، نحضّروا العرض، وإلا نترجمولك جملة؟")

    def inspect_site(self):
        scope = self.start
        climate = self.climate
        if climate:
            period = f"{climate.start} – {climate.end}"
            temp, rain = climate.temperature_mean_c, climate.precipitation_mm
            text = self.say(f"{self.site_label}, {period}. L’archive estime une température moyenne de {temp} °C et un cumul de précipitations de {rain} mm.",
                            f"{self.site_label}, {period}. The archive estimates a mean temperature of {temp} °C and total rainfall of {rain} mm.",
                            f"{self.site_label}、{period}。アーカイブによる推定平均気温は{temp} °C、積算降水量は{rain} mmです。",
                            f"في {self.site_label}، في الفترة {period}، الأرشيف يقدّر معدّل الحرارة بـ {temp} °C ومجموع الصبّة بـ {rain} mm.")
            return text, [{"title": climate.source.name, "url": str(climate.source.url)}]
        survey = self.service.catalog.agriculture.get(scope.site_id)
        if survey:
            n = len(survey.parcels)
            text = self.say(f"{self.site_label} compte {n} parcelles cartographiées. WaPOR estime l’évapotranspiration. Le besoin d’irrigation et le quota attendent une validation locale.",
                            f"{self.site_label} has {n} mapped parcels. WaPOR estimates evapotranspiration. Irrigation requirements and the withdrawal quota need local validation.",
                            f"{self.site_label} では{n}区画を地図化しています。WaPORは蒸発散量を推定します。灌漑必要量と取水枠は現地確認が必要です。",
                            f"في {self.site_label}، رسمنا {n} قطع أرض على الخريطة. WaPOR يقدّر الماء اللي يخرج بالتبخّر والنتح. قدّاش يلزم للسقي وقدّاش مسموح بالسحب، هذا يلزمو تثبّت في الميدان.")
            return text, []
        if scope.comparison:
            state = scope.comparison.state
            return self.say(f"{self.site_label}, début de la simulation : stock {state.tank_stock_m3} m³, quota de prélèvement restant {state.quota_remaining_m3} m³.",
                            f"{self.site_label} at the start of the simulation: stock {state.tank_stock_m3} m³, remaining withdrawal quota {state.quota_remaining_m3} m³.",
                            f"{self.site_label} のシミュレーション開始時の貯水量は{state.tank_stock_m3} m³、残りの取水枠は{state.quota_remaining_m3} m³です。",
                            f"في بداية المحاكاة متاع {self.site_label}، في الخزّان {state.tank_stock_m3} m³ ومازال مسموح نسحبو {state.quota_remaining_m3} m³."), []
        return self.site_summary(), []

    def replay_summary(self):
        if not self.frame:
            return self.say("Aucune heure de rejeu sélectionnée.", "Choose an hour on the replay timeline and we'll look at it together.", "再生する時刻を選ぶと、その時間帯の状況を一緒に確認できます。", "اختار الساعة في المحاكاة ونشوفو مع بعضنا شنوة صار فيها.")
        stock = self.frame["tank_stock_m3"]
        local = datetime.fromisoformat(self.frame["timestamp"]).astimezone(ZoneInfo("Africa/Tunis")).strftime("%Y-%m-%d %H:%M")
        message = self.say(f"Simulation à {self.site_label}, {local} heure de Tunis. Stock en fin d’heure : {stock} m³.",
                           f"Simulation at {self.site_label}, {local} Tunis time. End-of-hour stock: {stock} m³.",
                           f"{self.site_label} のシミュレーション、チュニス時間{local}。時間枠終了時の貯水量は{stock} m³です。",
                           f"في محاكاة {self.site_label}، نهار {local} بتوقيت تونس، بقى في الخزّان {stock} m³ في آخر الساعة.")
        if self.event:
            value = self.event["value"]
            details = "" if self.event["type"] != "unexplained_water" else self.say(
                f" Écart : {value:g} m³.", f" Discrepancy: {value:g} m³.", f" 差は{value:g} m³です。", f" الفرق {value:g} m³.")
            message += details + " " + self.say(*EVENTS[self.event["type"]])
        return message

    def plan_summary(self):
        if self.plan is None and self.start.comparison:
            self.plan = compare(self.service.catalog, self.start.comparison, self.service.solver_budget)
        unavailable = self.say("Aucune comparaison vérifiée pour ce contexte.", "Calculate the schedules first so I can show you what changes for each grower.", "先に計画を計算すると、農家ごとの違いを一緒に確認できます。", "أحسب البرامج أوّل، وبعد نشوفو مع بعضنا شنوة يتبدّل لكلّ فلّاح.")
        if not self.plan:
            return unavailable
        weather = self.plan.weather_comparison
        if weather:
            first, second = weather.reference_on_adverse, weather.buffer_on_adverse
        elif self.start.comparison and self.start.comparison.planning_mode == "weather_buffer":
            return unavailable
        else:
            first, second = self.plan.baseline, self.plan.optimized
        if not first.metrics or not second.metrics:
            return unavailable
        fixed, fair = (p.metrics.delivered_on_time_m3 for p in (first, second))
        if weather:
            text = self.say(f"Météo défavorable simulée : {fixed} m³ livrés à temps pour la référence et {fair} m³ avec la réserve anticipée.",
                            f"Simulated adverse weather: {fixed} m³ delivered on time with the reference plan and {fair} m³ with the reserve plan.",
                            f"悪天候シミュレーションの期限内配水量は基準計画が{fixed} m³、予備貯水計画が{fair} m³です。",
                            f"في محاكاة الطقس الصعيب، وصل الماء في وقتو: {fixed} m³ بالبرنامج المرجعي و{fair} m³ كي حضّرنا احتياطي من قبل.")
        else:
            text = self.say(f"Volume simulé livré à temps : {fixed} m³ avec le tour fixe et {fair} m³ avec le plan proposé.",
                            f"Simulated on-time deliveries: {fixed} m³ under the fixed rotation and {fair} m³ under the proposed plan.",
                            f"シミュレーションの期限内配水量は固定計画が{fixed} m³、提案計画が{fair} m³です。",
                            f"في المحاكاة، كمّية الماء اللي وصلت في وقتها هي {fixed} m³ بالدورة القارّة و{fair} m³ بالبرنامج المقترح.")
        before, after = first.metrics.worst_coverage_bp, second.metrics.worst_coverage_bp
        if before is not None and after is not None:
            text += " " + self.say(f"Couverture minimale : {before / 100:g} % puis {after / 100:g} %.",
                                    f"Least-served coverage: {before / 100:g}% then {after / 100:g}%.",
                                    f"最低充足率は{before / 100:g}%から{after / 100:g}%です。",
                                    f"تغطية أقلّ قطعة خذات ماء تبدّلت من {before / 100:g}% لـ {after / 100:g}%.")
        plots = {p.plot_id: p for p in first.plot_results or ()}
        changed = [p for p in second.plot_results or () if p.plot_id in plots and
                   p.delivered_on_time_m3 != plots[p.plot_id].delivered_on_time_m3]
        for plot in changed[:3]:
            a, b = plots[plot.plot_id].delivered_on_time_m3, plot.delivered_on_time_m3
            text += " " + self.say(f"Parcelle {plot.plot_id} : {a} puis {b} m³.", f"Plot {plot.plot_id}: {a} then {b} m³.",
                                    f"区画{plot.plot_id}は{a}から{b} m³です。", f"القطعة {plot.plot_id} خذات {a} وبعد {b} m³.")
        return text

    def presentation_topic(self, focus=None):
        if focus == "site" or (focus == "replay" and self.frame) or (focus == "plan" and (self.start.comparison or self.start.zone_plan)):
            return focus
        return "replay" if self.event else "plan" if self.start.comparison or self.start.zone_plan else "site"

    def presentation(self, focus, audience_opener=None):
        """Build a short, speakable walkthrough from the current view's verified results."""
        ctx = self.start
        citations = []
        if focus == "replay" and self.frame:
            opening = self.say("Voici comment présenter cette alerte.", "Here’s how I’d walk the audience through this alert.",
                               "このアラートを紹介するときは、こう伝えてみてください。", "باش تفسّر التنبيه للحاضرين، تنجّم تقول هكّا.")
            facts = self.replay_summary()
            closing = self.say("Montrez ensuite le même instant sur le jumeau et demandez quelle lecture vérifier sur place.",
                                "Show the same moment on the twin and ask which reading the team would check in the field.",
                                "次に、同じ時刻の画面を示し、現地でどの計器を確かめるか、聞き手に尋ねてみましょう。",
                                "بعد ورّي نفس اللحظة في المحاكاة واسألهم أنهي قراءة يلزمنا نثبّتو فيها في الميدان.")
        elif focus == "plan" and (ctx.comparison or ctx.zone_plan):
            opening = self.say(f"À {self.site_label}, posons une question : qui reçoit son eau à temps ?",
                               f"At {self.site_label}, let's start with a grower’s question: will the water reach my plot on time?",
                               f"{self.site_label}の農家の立場で考えてみましょう。「自分の畑に、必要なときに水は届くでしょうか？」",
                               f"في {self.site_label}، نبدأو بسؤال الفلّاح: الماء باش يوصل لقطعتي في وقتو؟")
            facts = self.plan_summary()
            closing = self.say("Montrez la répartition entre les parcelles. Le responsable peut examiner le résultat simulé avant de décider.",
                                "Point to the parcel deliveries. The manager can review the simulated trade-offs before deciding.",
                                "次に区画別の配水量を指し示してください。管理者は、この試算で各農家への影響を確かめてから判断できます。",
                                "بعد ورّي قداش خذات كلّ قطعة. المسؤول يشوف نتيجة المحاكاة وتأثيرها على الفلّاحة، وبعد يقرّر.")
        else:
            opening = self.say("Partons de la question que se pose le gestionnaire : comment continuer à irriguer quand l’eau ou l’électricité manque ?",
                               "Imagine it’s your turn to irrigate, and the power goes out. How would you decide where the remaining water should go?",
                               "水をまく順番が来たのに停電したら、残っている水をどの畑に届けますか。まず、この問いから始めましょう。",
                               "تصوّر يجي نهار نوبتك في السقي ويتقصّ الضوّ. كيفاش تقرّر وين تمشّي الماء اللي مازال في الخزّان؟")
            if self.climate or ctx.site_id in self.service.catalog.agriculture:
                facts, citations = self.inspect_site()
            else:
                facts = self.say(f"Nous partons de la carte : {self.site_label}.", f"We’re looking at {self.site_label} on the map.",
                                 f"いま地図で見ているのは{self.site_label}です。", f"توّا نشوفو في {self.site_label} على الخريطة.")
            closing = self.say("Passez ensuite au simulateur pour comparer les tours d’eau et vérifier les hypothèses avec le public.",
                                "From the map, open a planning site. The audience can change an assumption and compare who receives water under each schedule.",
                                "次に計画を試せる地点を開きましょう。条件を一つ変えると、各計画でどの畑に水が届くかを比べられます。",
                                "بعد اختار من الخريطة موقع فيه محاكاة. الحاضرين ينجّموا يبدّلوا فرضيّة ويقارنوا شكون يوصلو الماء في كلّ برنامج.")
        return {"type": "reply", "activity": "present", "text": " ".join([audience_opener or opening, facts, closing]), "citations": citations}

    def evidence(self, query: str, *, local_only=False):
        service = self.service
        hits = []
        if not local_only and service.providers and service.capacity.acquire(blocking=False):
            try:
                hits = search(service.corpus, service.providers, query, timeout=6, limit=2)
            except ServiceError:
                pass
            finally:
                service.capacity.release()
        if not hits:
            # Only use real passages present in the locally verified M8 corpus.
            hits = [service.corpus.chunks[key].citation for key in service.corpus.lexical.rank(query, 2)]
        if not hits:
            return self.say("Aucun extrait vérifié ne répond à cette recherche.", "I couldn't find a verified passage for that question.", "この質問に対応する確認済みの資料は見つかりませんでした。", "ما لقيتش في الوثائق مقطع موثوق يجاوب على سؤالك."), []
        source = hits[0]
        text = self.say("Extrait documentaire de", "Documentary excerpt from", "資料の抜粋", "هذا مقتطف من وثيقة متاع") + f" {source.organization} : « {source.excerpt} »"
        return text, [{"title": h.title, "url": str(h.url), "excerpt": h.excerpt, "organization": h.organization} for h in hits]

    def propose(self, quota: int):
        self.proposal = None
        ctx, service = self.start, self.service
        if ctx.zone_plan:
            old = ctx.zone_plan.inputs.withdrawal_limit_m3
        elif ctx.comparison:
            old = ctx.comparison.state.quota_remaining_m3
        else:
            raise ValueError("No plan")
        if type(quota) is not int or not 0 <= quota < old:
            raise ValueError("Choose a reduced quota")
        if ctx.zone_plan:
            inputs = ctx.zone_plan.inputs.model_copy(update={"withdrawal_limit_m3": quota})
            zone = compare_zone(service.catalog.zone_planning[ctx.site_id], inputs, service.solver_budget)
            plan = zone.comparison
            payload = {"zone_inputs": inputs.model_dump(mode="json"), "zone_result": zone.model_dump(mode="json")}
        else:
            state = ctx.comparison.state.model_copy(update={"quota_remaining_m3": quota})
            inputs = ctx.comparison.model_copy(update={"state": state})
            plan = compare(service.catalog, inputs, service.solver_budget)
            payload = {"comparison": inputs.model_dump(mode="json"), "result": plan.model_dump(mode="json")}
        selected = plan.optimized
        if ctx.comparison and ctx.comparison.planning_mode == "weather_buffer":
            if plan.weather_comparison is None:
                raise ValueError("No verified adverse projection")
            selected = plan.weather_comparison.buffer_on_adverse
        if selected.status not in {"OPTIMAL", "FEASIBLE"} or not selected.metrics:
            raise ValueError("No verified plan")
        identifier = uuid4().hex
        self.proposal = {"id": identifier, **payload}
        return {"id": identifier, "previous_quota_m3": old, "quota_m3": quota,
                "delivered_on_time_m3": selected.metrics.delivered_on_time_m3}

    def confirm(self):
        receipt = self.proposal
        if "zone_result" in receipt:
            zone = receipt["zone_result"]
            updates = {"zone_plan": RegionalPlanContext(inputs=receipt["zone_inputs"], comparison_id=zone["comparison_id"])}
            self.plan = Comparison.model_validate(zone["comparison"])
        else:
            updates = {"comparison": CompareRequest.model_validate(receipt["comparison"])}
            self.plan = Comparison.model_validate(receipt["result"])
        self.start = self.start.model_copy(update={**updates, "telemetry": None, "reason": "accessibility"})
        self.frame = self.event = self.proposal = None
        self.history.clear()
        self.presentation_brief = ""
        return receipt
