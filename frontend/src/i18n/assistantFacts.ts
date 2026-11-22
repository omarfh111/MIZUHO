// Translate only the labels in M6/M8's deterministic fact templates. Captures are
// displayed exactly as supplied, including precision, units, IDs and source names.
export const factLabelsJa: Record<string, string> = {
  'mean air temperature': '平均気温', 'total precipitation': '総降水量', 'mean daily solar irradiation': '日積算日射量の平均',
  'Fixed regional schedule': '地域の固定順計画', 'Proposed regional schedule': '地域の提案計画', 'Before the hypothetical reduction': '取水枠の仮想削減前',
  'Fixed schedule': '固定順計画', 'Proposed schedule': '提案計画', 'Recovery schedule': '復旧計画', 'Previous schedule replay': '従来計画の再生',
  'Weather reference': '気象条件の基準計画', 'Proposed schedule before the quota reduction': '取水枠の削減前の提案計画',
  'Normal day': '通常日', 'A/B demo': 'A/Bデモ', unavailable: 'データなし', west: '西', east: '東',
  observed: '観測', simulated: 'シミュレーション', estimated: '推定',
  'City data provide regional context. Irrigation planning needs validated farm demand, water rights, equipment, and initial stock.': '都市のデータは地域の状況を示します。灌漑計画には検証済みの水需要、水利権、設備、初期貯水量が必要です。',
  'The land-cover classification provides no parcel, irrigation or pumping measurements.': '土地被覆の分類からは、区画、灌漑、揚水の実測値は得られません。',
  'A climate archive is unavailable for this city.': 'この都市の過去の気候記録はありません。',
  'An elevation grid is unavailable for this city.': 'この都市の標高格子データはありません。',
  'The pilot has no observed borehole levels, pumping test or metered well withdrawals.': '実証サイトには井戸水位の観測値、揚水試験の結果、井戸からの取水量の実測値がありません。',
  'Site-level measured load and verified annual costs are unavailable. The archived PVGIS profiles estimate production at the Jendouba reference coordinates.': '現地の電力負荷の実測値と検証済みの年間費用はありません。PVGISの記録はジェンドゥーバの基準座標における発電量の推定値です。',
  'No mapped agricultural survey matches the active site and parcel.': '選択したサイトと区画に該当する農地調査データはありません。',
  'Simulation inputs changed. Recalculate the schedules before asking about current results.': 'シミュレーション条件が変更されました。現在の結果について質問する前に計画を再計算してください。',
  'The comparison uses simulated inputs. Field measurements are needed for an operational decision.': 'この比較はシミュレーションの入力条件に基づきます。現場で判断するには実測値が必要です。',
  'Run the regional comparison with explicit station assumptions to explain a plan at this site.': 'このサイトの計画を説明するには、設備条件を設定して地域別比較を実行してください。',
  'The server could not reproduce the displayed schedule exactly. Recalculate before asking about its allocations.': '表示中の計画と同じ結果をサーバーで再現できませんでした。配水量について質問する前に再計算してください。',
  'Select a calculated plan in the digital twin to inspect its virtual meters.': '仮想計器を確認するには、デジタルツインで計算済みの計画を選んでください。',
  'Weather planning protects minimum coverage under both profiles before minimizing early pumping.': '気象条件を考慮した計画では、両方の気象条件で最低充足率を確保してから、前倒しの揚水量を最小化します。',
  'The solver maximizes the worst priority coverage before weighted shortfall and delivered water, then minimizes grid peak, grid energy, and water withdrawals.': '最適化では優先区画の最低充足率をまず最大化し、重み付き不足量と配水量を評価したうえで、系統の最大電力、買電量、取水量を順に最小化します。',
  'Grid-tied pumping is unavailable during outages. Gravity-fed delivery can continue while water remains in the reservoir.': '停電中は系統電力による揚水ができません。貯水池に水が残っている間は自然流下で配水できます。',
  'The proposed plan exhausts the available withdrawal quota.': '提案計画では利用可能な取水枠を使い切ります。',
};

type FactPattern = [RegExp, (...matches: string[]) => string];

export function assistantFactPatterns(label: (source: string) => string): FactPattern[] {
  return [
    [/^(.+) GeoNames reference point: (.+?)° N, (.+?)° E\.$/, (_, city, lat, lon) => `${label(city)}のGeoNames基準点：北緯${lat}度、東経${lon}度。`],
    [/^(.+) (mean air temperature|total precipitation|mean daily solar irradiation): (.+?) (°C|mm|kWh\/m²\/day) \((\d{4}-\d\d-\d\d) to (\d{4}-\d\d-\d\d), (\d+) days, (.+)\)\.$/, (_, city, metric, value, unit, start, end, days, source) =>
      `${label(city)}の${label(metric)}は${value} ${unit}（${start}～${end}、${days}日間、${source}）。`],
    [/^(.+) sampled terrain: (.+?) to (.+?) m elevation across the city window \((.+)\)\.$/, (_, city, min, max, source) => `${label(city)}の表示範囲で標本化した標高：${min}～${max} m（${source}）。`],
    [/^Complete (mean air temperature|total precipitation|mean daily solar irradiation) is unavailable for this period\.$/, (_, name) => `この期間の${label(name)}には欠測があります。`],
    [/^(.+): ([\d.]+)% of valid WorldCover 2021 pixels are cropland; largest class: (.+)\.$/, (_, site, share, category) => `${label(site)}：WorldCover 2021の有効画素の${share}%が農地です。最も多い土地被覆は「${label(category)}」です。`],
    [/^(.+): sampled elevation (.+?) to (.+?) m\.$/, (_, site, min, max) => `${label(site)}の標高サンプル範囲は${min}～${max} mです。`],
    [/^(.+) NASA POWER archive \((.+?) to (.+?)\): (.+?) °C mean air temperature, (.+?) mm precipitation, (.+?) kWh\/m²\/day mean solar irradiation\.$/, (_, site, start, end, temp, rain, sun) =>
      `${label(site)}のNASA POWER記録（${start}～${end}）：平均気温${temp} °C、降水量${rain} mm、日積算日射量の平均${sun} kWh/m²/日。`],
    [/^(.+) site: (.+) Site data status: (observed|simulated|estimated|unavailable)\.$/, (_, site, description, status) => `${label(site)}：${label(description)} データ区分：${label(status)}。`],
    [/^(.+) reference point: (.+?)° latitude, (.+?)° longitude in WGS84\.$/, (_, site, lat, lon) => `${label(site)}の基準点：緯度${lat}度、経度${lon}度（WGS84）。`],
    [/^(.+) layer: (observed|simulated|estimated|unavailable); (\d+) mapped features\.$/, (_, layer, status, n) => `${label(layer)}レイヤー：${label(status)}、地物${n}件。`],
    [/^(.+): (\d+) m³ delivered on time; (\d+) m³ withdrawn; minimum coverage ([\d.]+%|unavailable); (.+?) kWh of grid energy and (.+?) kW peak grid power\.$/, (_, plan, ontime, withdrawn, coverage, kwh, kw) =>
      `${label(plan)}：期限内配水量${ontime} m³、取水量${withdrawn} m³、最低充足率${label(coverage)}、買電量${kwh} kWh、系統の最大電力${kw} kW。`],
    [/^(.+): no verified plan available\.$/, (_, plan) => `${label(plan)}：検証済みの計画がありません。`],
    [/^(.+), (\d{4}-\d\d-\d\d): (.+?) kWh\/m² of archived daily irradiation at the study point\.$/, (_, site, day, value) => `${site}（${day}）の基準地点における日積算日射量の記録は${value} kWh/m²です。`],
    [/^Assumed starting stock (\d+) m³, withdrawal limit (\d+) m³, PV capacity (.+?) kWp\. Modelled potential PV energy (.+?) kWh\.$/, (_, stock, limit, capacity, energy) =>
      `仮定した初期貯水量${stock} m³、取水上限${limit} m³、太陽光設備容量${capacity} kWp。モデル上の発電可能量は${energy} kWhです。`],
    [/^(\d{4}-\d\d-\d\d) NASA POWER meteorology at the study point: (.+?) mm gross rain and (.+?) °C mean temperature\.$/, (_, day, rain, temp) => `${day}の基準地点のNASA POWER気象データ：総降雨量${rain} mm、平均気温${temp} °C。`],
    [/^MIZUHO derived (.+?) mm of daily reference evapotranspiration using FAO-56 and the archived weather\.$/, (_, et0) => `MIZUHOはFAO-56と過去の気象記録から、日基準蒸発散量を${et0} mmと算出しました。`],
    [/^The (west|east) sector demand of (\d+) m³ was calculated assuming (.+?) m², crop coefficient (.+?), (.+?) effective rainfall fraction and (.+?) application efficiency\.$/, (_, zone, demand, area, kc, rain, eff) =>
      `${label(zone)}区画の水需要${demand} m³は、面積${area} m²、作物係数${kc}、有効雨量率${rain}、灌漑効率${eff}を仮定して算出しました。`],
    [/^Hypothetical (west|east) sector: (\d+) m³ delivered by the deadline against (\d+) m³ assumed demand\.$/, (_, zone, delivery, target) => `仮想${label(zone)}区画：想定需要${target} m³のうち、期限までに${delivery} m³を配水しました。`],
    [/^(.+) inputs: (\d+) m³ starting stock and (\d+) m³ remaining withdrawal quota\.$/, (_, scenario, stock, quota) => `${label(scenario)}の入力条件：初期貯水量${stock} m³、残り取水枠${quota} m³。`],
    [/^Plot ([\w-]+) \((.+?)\): (\d+) m³ by its deadline, (\d+) m³ minimum and (\d+) m³ total demand\.$/, (_, plot, farmer, volume, min, demand) => `区画${plot}（${farmer}）：期限内配水量${volume} m³、最低必要量${min} m³、総需要${demand} m³。`],
    [/^Weather reserve: (\d+) m³ pumped before hour (\d+); (\d+) m³ minimum delivery shortfall under adverse conditions\.$/, (_, water, hour, deficit) => `悪天候への備え：${hour}時前に${water} m³を揚水。悪条件での最低配水量に対する不足は${deficit} m³です。`],
    [/^(P-[\w-]+): OpenStreetMap way (\d+), mapped as (.+?)\.$/, (_, id, osm, use) => `${id}：OpenStreetMapのway ${osm}、土地利用区分は${use}。`],
    [/^(P-[\w-]+): mapped area (.+?) m²; FAO WaPOR AETI (.+?) mm\/day over (.+?) at (.+?)\. Positive ET minus gross rain equals (.+?) m³\/day\.$/, (_, id, area, aet, period, res, balance) =>
      `${id}：地図上の面積${area} m²。FAO WaPORのAETIは${aet} mm/日（${period}、解像度${res}）。実蒸発散量と総降雨量の正の差は${balance} m³/日です。`],
    [/^(P-[\w-]+): rain-adjusted WaPOR AETI association with NASA POWER maximum temperature (.+?) mm\/day per °C, p=(.+?), across (\d+) ten-day periods\. This association cannot establish causation\.$/, (_, id, slope, p, samples) =>
      `${id}：降雨量調整後のWaPOR AETIとNASA POWER最高気温の関連は${slope} mm/日/°C（p=${p}、対象は${samples}旬）。この関連だけでは因果関係を判断できません。`],
  ];
}
