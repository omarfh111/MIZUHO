"""Ground M9 turns in the active site's verified M3/M4 replay, M5 result and M8 corpus."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import Field

from .assistant_api import AssistantRuntime
from .compare import compare, effective_scenario
from .evidence import search
from .models import AssistantTelemetry, CompareRequest, Comparison, PlanningModel, RegionalPlanContext
from .providers import ServiceError
from .telemetry import known_site, replay
from .tunisia import ARCHIVE_DIR, get_city_analysis
from .zone_planning import compare_zone


class CallStart(PlanningModel):
    type: Literal["start"]
    site_id: Annotated[str, Field(min_length=1, max_length=120)] | None = None
    city_id: Annotated[str, Field(pattern=r"^\d{1,12}$")] | None = None
    reason: Literal["accessibility", "emergency", "clarification"]
    language: Literal["fr", "en", "ja"] = "fr"
    comparison: CompareRequest | None = None
    telemetry: AssistantTelemetry | None = None
    zone_plan: RegionalPlanContext | None = None


EVENTS = {
    "unexplained_water": ("Le bilan d’eau présente un écart inexpliqué. Pouvez-vous vérifier le compteur et le niveau de la cuve avant de conclure à une fuite ?", "The water balance shows an unexplained discrepancy. Can you check the meter and tank level before attributing it to a leak?", "水収支に原因不明の差があります。漏水と判断する前に、計器と貯水量を確認できますか。"),
    "high_pump_energy_intensity": ("L’énergie consommée par volume pompé dépasse la référence. Pouvez-vous vérifier le débit et le compteur électrique ?", "Energy per volume pumped exceeds the reference. Can you check flow and the electricity meter?", "揚水量あたりの電力量が基準を超えました。流量と電力量計を確認できますか。"),
    "grid_outage": ("Le réseau électrique est coupé. Pouvez-vous vérifier l’alimentation de la pompe ?", "Grid power is interrupted. Can you check the pump supply?", "停電が発生しました。ポンプの電源を確認できますか。"),
    "tank_empty": ("La cuve est vide. Pouvez-vous vérifier le niveau avant la prochaine distribution ?", "The reservoir is empty. Can you check the level before the next delivery?", "貯水槽が空です。次の配水前に水位を確認できますか。"),
    "pump_shutdown": ("La pompe est indisponible. Pouvez-vous vérifier son état ?", "The pump is unavailable. Can you check its status?", "ポンプが使用できません。状態を確認できますか。"),
    "missing_flow": ("La mesure du débit manque. Que montre le compteur local ? Une absence de lecture ne signifie pas un débit nul.", "The flow reading is missing. What does the local meter show? A missing reading does not establish zero flow.", "流量計の値が欠測しています。現地の計器には何が表示されていますか。欠測は流量ゼロを意味しません。"),
}
PRIORITY = ("unexplained_water", "high_pump_energy_intensity", "pump_shutdown", "tank_empty", "grid_outage", "missing_flow")


@dataclass
class Dialogue:
    start: CallStart
    service: AssistantRuntime
    archive: Path = ARCHIVE_DIR
    site_label: str = ""
    frame: dict | None = None
    event: dict | None = None
    plan: Comparison | None = None
    observations: list[str] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)
    proposal: dict | None = None
    approval_failures: int = 0
    last_text: str = ""

    def say(self, fr: str, en: str, ja: str) -> str:
        return {"fr": fr, "en": en, "ja": ja}[self.start.language]

    def open(self):
        ctx, catalog = self.start, self.service.catalog
        if not ctx.site_id:
            if ctx.reason != "accessibility" or ctx.comparison or ctx.telemetry or ctx.zone_plan:
                raise ValueError("No registered station")
            self.site_label = get_city_analysis(ctx.city_id, self.archive).city.name if ctx.city_id else self.say("Tunisie", "Tunisia", "チュニジア")
            return self.site_summary()
        if ctx.city_id:
            raise ValueError("Conflicting locations")
        site = known_site(catalog, ctx.site_id)
        self.site_label = site.label
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
                            f"{site.label}。現在の取水許可量の残りを確認できますか。")
        return self.site_summary()

    def site_summary(self):
        if not self.start.site_id:
            return self.say(f"Atlas : {self.site_label}. Vous pouvez consulter les sources. Sélectionnez une station pour examiner une alerte ou un planning.",
                            f"Atlas: {self.site_label}. You can ask about evidence. Select a field station to review alerts or a schedule.",
                            f"地図：{self.site_label}。資料について質問できます。警報や計画を確認するには対象地点を選択してください。")
        return self.say(f"Vous consultez {self.site_label}. Demandez-moi d’expliquer un graphique, un plan ou une source.",
                        f"You are viewing {self.site_label}. Ask me about a chart, a plan or its sources.",
                        f"{self.site_label} を表示しています。グラフや計画、資料について質問できます。")

    def inspect_site(self):
        scope = self.start
        zone = self.service.catalog.field_zones.get(scope.site_id)
        climate = zone.climate if zone else get_city_analysis(scope.city_id, self.archive).climate if scope.city_id else None
        if climate:
            period = f"{climate.start} – {climate.end}"
            temp, rain = climate.temperature_mean_c, climate.precipitation_mm
            text = self.say(f"{self.site_label}, {period}. L’archive estime une température moyenne de {temp} °C et un cumul de précipitations de {rain} mm.",
                            f"{self.site_label}, {period}. The archive estimates a mean temperature of {temp} °C and total rainfall of {rain} mm.",
                            f"{self.site_label}、{period}。アーカイブによる推定平均気温は{temp} °C、積算降水量は{rain} mmです。")
            return text, [{"title": climate.source.name, "url": str(climate.source.url)}]
        survey = self.service.catalog.agriculture.get(scope.site_id)
        if survey:
            n = len(survey.parcels)
            text = self.say(f"{self.site_label} compte {n} parcelles cartographiées. WaPOR estime l’évapotranspiration. Le besoin d’irrigation et le quota attendent une validation locale.",
                            f"{self.site_label} has {n} mapped parcels. WaPOR estimates evapotranspiration. Irrigation requirements and the withdrawal quota need local validation.",
                            f"{self.site_label} では{n}区画を地図化しています。WaPORは蒸発散量を推定します。灌漑必要量と取水枠は現地確認が必要です。")
            return text, []
        if scope.comparison:
            state = scope.comparison.state
            return self.say(f"{self.site_label}, début de la simulation : stock {state.tank_stock_m3} m³, quota de prélèvement restant {state.quota_remaining_m3} m³.",
                            f"{self.site_label} at the start of the simulation: stock {state.tank_stock_m3} m³, remaining withdrawal quota {state.quota_remaining_m3} m³.",
                            f"{self.site_label} のシミュレーション開始時の貯水量は{state.tank_stock_m3} m³、残りの取水枠は{state.quota_remaining_m3} m³です。"), []
        return self.site_summary(), []

    def replay_summary(self):
        if not self.frame:
            return self.say("Aucune heure de rejeu sélectionnée.", "No replay hour is selected.", "再生時刻が選択されていません。")
        slot, stock = self.frame["slot"], self.frame["tank_stock_m3"]
        message = self.say(f"Simulation à {self.site_label}, {slot} h. Stock en fin d’heure : {stock} m³.",
                           f"Simulation at {self.site_label}, hour {slot}. End-of-hour stock: {stock} m³.",
                           f"{self.site_label} のシミュレーション、{slot}時。時間枠終了時の貯水量は{stock} m³です。")
        if self.event:
            value = self.event["value"]
            details = "" if self.event["type"] != "unexplained_water" else self.say(
                f" Écart : {value:g} m³.", f" Discrepancy: {value:g} m³.", f" 差は{value:g} m³です。")
            message += details + " " + self.say(*EVENTS[self.event["type"]])
        return message

    def plan_summary(self):
        if self.plan is None and self.start.comparison:
            self.plan = compare(self.service.catalog, self.start.comparison, self.service.solver_budget)
        unavailable = self.say("Aucune comparaison vérifiée pour ce contexte.", "No verified comparison in this context.", "この条件で比較可能な検証済み計画はありません。")
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
                            f"悪天候シミュレーションの期限内配水量は基準計画が{fixed} m³、予備貯水計画が{fair} m³です。")
        else:
            text = self.say(f"Volume simulé livré à temps : {fixed} m³ avec le tour fixe et {fair} m³ avec le plan proposé.",
                            f"Simulated on-time deliveries: {fixed} m³ under the fixed rotation and {fair} m³ under the proposed plan.",
                            f"シミュレーションの期限内配水量は固定計画が{fixed} m³、提案計画が{fair} m³です。")
        before, after = first.metrics.worst_coverage_bp, second.metrics.worst_coverage_bp
        if before is not None and after is not None:
            text += " " + self.say(f"Couverture minimale : {before / 100:g} % puis {after / 100:g} %.",
                                    f"Least-served coverage: {before / 100:g}% then {after / 100:g}%.",
                                    f"最低充足率は{before / 100:g}%から{after / 100:g}%です。")
        plots = {p.plot_id: p for p in first.plot_results or ()}
        changed = [p for p in second.plot_results or () if p.plot_id in plots and
                   p.delivered_on_time_m3 != plots[p.plot_id].delivered_on_time_m3]
        for plot in changed[:3]:
            a, b = plots[plot.plot_id].delivered_on_time_m3, plot.delivered_on_time_m3
            text += " " + self.say(f"Parcelle {plot.plot_id} : {a} puis {b} m³.", f"Plot {plot.plot_id}: {a} then {b} m³.",
                                    f"区画{plot.plot_id}は{a}から{b} m³です。")
        return text

    def evidence(self, query: str):
        service = self.service
        hits = []
        if service.providers and service.capacity.acquire(blocking=False):
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
            return self.say("Aucun extrait vérifié ne répond à cette recherche.", "No verified passage matched the search.", "該当する検証済み資料はありません。"), []
        source = hits[0]
        text = self.say("Extrait documentaire de", "Documentary excerpt from", "資料の抜粋") + f" {source.organization} : « {source.excerpt} »"
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
        return receipt
