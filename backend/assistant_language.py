"""Japanese renderings of the simulator's deterministic explanations and data gaps."""

import re


_SENTENCES = {
    "The figures below compare the reference and proposed schedules under the same inputs.":
        "同じ条件で固定計画と提案計画を計算しました。各計画の結果を以下に示します。",
    "The schedules below show the effect of rerunning the model with a lower withdrawal quota.":
        "取水可能量を減らして再計算した結果を以下に示します。",
    "The original comparison and approved plan remain separate from this hypothetical case.":
        "この仮定での試算は、元の比較結果や承認済みの計画とは別に扱います。",
    "The reserve leaves some minimum demand unmet under adverse conditions.":
        "不利な気象条件では、予備水量を使っても最低限の需要を満たせない区画があります。",
    "Pumping before the risk window protects minimum deliveries under the adverse profile.":
        "リスクが高まる前に揚水することで、不利な条件でも最低配水量を確保します。",
    "Weather planning protects minimum coverage under both profiles before minimizing early pumping.":
        "気象条件の異なる両ケースで最低充足率を確保したうえで、事前の揚水を最小限にします。",
    "The solver maximizes the worst priority coverage before weighted shortfall and delivered water, then minimizes grid peak, grid energy, and water withdrawals.":
        "最適化では充足率が最も低い区画を優先し、次に重み付き不足量と配水量を考慮します。そのうえで系統の最大電力、使用電力量、取水量を抑えます。",
    "Grid-tied pumping is unavailable during outages.": "停電中は系統連系のポンプを運転できません。",
    "Gravity-fed delivery can continue while water remains in the reservoir.": "貯水が残っている間は自然流下で配水できます。",
    "The proposed plan exhausts the available withdrawal quota.": "提案計画では利用可能な取水枠を使い切ります。",
    "The fixed turn alternates sectors.": "固定の配水順では両地区に交互に配水します。",
    "The solver prioritizes the least-covered sector under the same tank, pump, grid and delivery constraints.":
        "同じ貯水槽、ポンプ、電力、配水の制約のもとで、最適化では充足率が最も低い地区を優先します。",
    "The sectors represent hypothetical demand on mapped cropland.": "地区の需要は、地図上で農地に分類された場所に設定した仮定値です。",
    "The solver returned no verified proposed schedule within its budget.": "制限時間内に検証済みの提案計画を得られませんでした。",
    "Only the fixed schedule can be assessed.": "評価できるのは固定計画のみです。",
    "The proposed schedule passed the physical checks; optimality was not established within the time limit.":
        "提案計画は物理的な制約を満たしていますが、制限時間内に最適性は確認できませんでした。",
    "The reduced withdrawal limit is a separate what-if calculation.": "取水枠を減らした結果は別の条件での試算です。",
    "The city profile combines a mapped location, archived climate estimates, and sampled elevation where available.":
        "都市の位置に、利用可能な過去の気候推定値と標高データを重ねて表示します。",
    "The research describes this site's water management context.": "この研究は現地の水管理の背景を説明しています。",
    "The mapped cover and regional climate estimates help frame field questions.": "土地被覆と地域の気候推定値から、現地で確認すべき項目を絞り込めます。",
    "The site and layer records below identify which pilot data are available and how they were obtained.":
        "この地点で利用できるデータと、その取得方法を以下に示します。",
    "Archived PVGIS estimates describe the reference location and day.": "PVGIS の推定値は基準地点と対象日の値です。",
    "Grid savings use simulated pumping demand.": "系統電力の削減量は模擬的な揚水需要から算出しています。",
    "The solar options are compared using their modeled generation and avoided grid energy.":
        "太陽光設備は推定発電量と削減できる系統電力量で比較します。",
    "Those results describe the modeled day.": "結果はシミュレーション対象日の値です。",
    "A field recommendation requires site measurements.": "現地への導入を判断するには実測が必要です。",
    "Parcel volumes estimate positive actual evapotranspiration minus gross rainfall.":
        "区画の水量は実蒸発散量から総降水量を引いた正の差による推定です。",
    "Irrigation demand requires crop, soil storage, effective rain and application efficiency.":
        "灌漑需要の算定には作物、土壌の保水量、有効雨量、灌漑効率が必要です。",
    "No validated withdrawal quota or operational schedule is available.": "検証済みの取水枠と運転計画はありません。",
    "These virtual meters describe the supplied actions after physical feasibility checks.":
        "仮想計器は物理的な制約を検証した後の運転内容を示します。",
    "Solver optimality is available separately from the planning results.": "最適性は計画結果で別途確認できます。",
    "A missing reading leaves the physical state intact.": "計測値が欠けても設備の物理状態は変わりません。",
    "An unexplained balance calls for checking meter readings and reservoir stock before assigning a cause.":
        "水収支が合わない場合は、原因を判断する前に計器の読み値と貯水量を確認してください。",
    "These verified results describe the available context.": "確認できたデータを以下に示します。",
    "I could not establish a further explanation from them.": "これらの結果からさらに詳しい理由を確認することはできませんでした。",
    "I don't have enough verified evidence or simulation results to answer this question.":
        "この質問に答えるための検証済みの資料またはシミュレーション結果が不足しています。",
    "The server could not reproduce the displayed schedule exactly.": "表示中の計画をサーバーで再現できませんでした。",
    "Recalculate before asking about its allocations.": "配分について質問する前に再計算してください。",
    "The comparison uses simulated inputs.": "この比較はシミュレーションの入力値を使用しています。",
    "Field measurements are needed for an operational decision.": "実際の運用を決めるには現地の計測値が必要です。",
    "The evidence search found no matching verified passage.": "該当する検証済みの原文が見つかりませんでした。",
    "The assistant reached its tool-call budget before finishing the answer.":
        "回答を完了する前に、利用できる照会回数の上限に達しました。",
    "The answer uses the verified results already retrieved.": "以下はすでに取得して検証できた結果です。",
    "Simulation inputs changed.": "シミュレーションの入力値が変更されました。",
    "Recalculate the schedules before asking about current results.": "現在の結果について質問する前に、計画を再計算してください。",
}


def japanese_explanation(text: str) -> str:
    """Translate known templates. Preserve model prose, original names and numerical evidence verbatim."""
    sentences = re.split(r"(?<=\.)\s+", text)
    localized = []
    for sentence in sentences:
        if sentence.endswith(" is unavailable for this answer."):
            localized.append(f"この回答では {sentence.removesuffix(' is unavailable for this answer.')} を利用できません。")
        elif sentence.endswith(" could not complete the response."):
            localized.append(f"{sentence.removesuffix(' could not complete the response.')} は応答を完了できませんでした。")
        else:
            localized.append(_SENTENCES.get(sentence, sentence))
    return "".join(part + (" " if i + 1 < len(localized) and not part.endswith("。") else "")
                   for i, part in enumerate(localized))
