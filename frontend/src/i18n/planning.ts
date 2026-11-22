import { dailyPlanningJa } from './dailyPlanning.ts';
import { deliveryAuditJa } from './deliveryAudit.ts';
import { outagePlanningJa } from './outagePlanning.ts';
import { regionalPlanningJa } from './regionalPlanning.ts';
import { telemetryPlanningJa } from './telemetryPlanning.ts';

export const planningJa: Record<string, string> = {
  ...regionalPlanningJa, ...dailyPlanningJa, ...outagePlanningJa, ...deliveryAuditJa, ...telemetryPlanningJa,
  'Total demand left unserved across the replay is': '再生期間を通じた未充足需要量：',
  'Total shortfall for those measured parcels was': '実測した区画の不足量の合計：',
  'Valid': '有効', 'valid': '有効', 'missing': '欠測', 'suspect': '要確認',
  'Grid supply restored.': '系統からの給電が復旧しました。',
  'Pump available again.': 'ポンプが再び利用可能です。',
  'Unexplained water balance. Inspect the meters and reservoir.': '水収支に説明のつかない差があります。計器と貯水槽を確認してください。',
  'supply six columns. Keep the comma for a missing reading.': '6列を入力してください。欠測値は空欄とし、区切りのコンマは残してください。',
  'enter a completed day before today in Tunis as YYYY-MM-DD.': 'チュニス現地時間で昨日以前の日付をYYYY-MM-DD形式で入力してください。',
  'all parcels must belong to the same local delivery day.': 'すべての区画には現地時間の同一配水日を指定してください。',
  'enter a parcel code of 1–32 letters, digits, hyphens or underscores, starting with a letter or digit.': '英数字で始まる1～32文字の区画コードを入力してください。英数字、ハイフン、アンダースコアを使用できます。',
  'this parcel code already has a commitment for the day.': 'この区画コードには同じ日の配水予定が既にあります。',
  'last_slot must be a whole hour from 0 through 23.': 'last_slotには0～23の整数を入力してください。',
  'minimum_m3 must be greater than zero for a delivery commitment.': '配水予定のminimum_m3には正の値を入力してください。',
  'the day-end delivery cannot be less than the volume delivered by the deadline.': '日末時点の配水量は、期限時点の配水量以上でなければなりません。',
  'the deadline is the end of the day, so both readings must agree.': '期限が日末なので、両方の計測値を一致させてください。',
};

const label = (source: string) => planningJa[source] ?? source;
const plot = (source: string) => source.startsWith('Plot ') ? '区画' + source.slice(5) : label(source);

function commitments(source: string) {
  return source.replace(/(West sector|East sector|Plot [\w-]+) falls ([\d.,]+ m³) short (?:with no eligible slot by ([\d:]+)|by the ([\d:]+) slot)/g,
    (_, parcel, missing, unavailable, deadline) => unavailable
      ? plot(parcel) + 'は' + unavailable + 'までに配水可能な時間枠がなく、' + missing + '不足します'
      : plot(parcel) + 'は' + deadline + 'の時間枠までに' + missing + '不足します')
    .replace(/\.(?: Some parcel results are unavailable\.)?$/, ending => ending === '.' ? '。' : '。一部の区画の結果がありません。');
}

// Match the complete source phrase so quantities keep their units when Japanese reorders a sentence.
// Survey and meter identifiers are deliberately preserved, including user-supplied parcel codes.
export const planningPatterns: [RegExp, (...matches: string[]) => string][] = [
  [/^(Tank capacity|Initial tank stock|Withdrawal limit|West sector demand|East sector demand|Gravity delivery capacity|Pump capacity|Pump energy intensity|Grid power ceiling|PV array capacity|PV performance ratio) \((.+)\)$/, (_, field, unit) => label(field) + '（' + unit + '）'],
  [/^The (fixed turn|optimized plan) has no actions to replay\.$/, (_, plan) => label(plan === 'fixed turn' ? 'Fixed turn' : 'Optimized plan') + 'には再生できる作業がありません。'],
  [/^(West|East) · ([\d.,]+ m³)$/, (_, side, amount) => label(side) + '区画・' + amount],
  [/^Reservoir · ([\d.,]+ m³)$/, (_, amount) => '貯水槽・' + amount],
  [/^Solver status · (optimal|feasible|no solution)\.$/, (_, status) => '求解状況：' + label(status)],
  [/^([\d.,]+) of ([\d.,]+) m³ delivered on time\.(?: (.+))?$/, (_, done, total, reason) => '需要量' + total + ' m³のうち、期限内の配水量は' + done + ' m³です。' + (reason ? label(reason) : '')],
  [/^Use manual (west|east) demand$/, (_, side) => label(side) + '区画の需要を手入力する'],
  [/^FAO-56 reference ET₀ ([\d.,]+) mm · Gridded rainfall ([\d.,]+) mm$/, (_, et, rain) => 'FAO-56基準蒸発散量ET₀：' + et + ' mm・格子降水量：' + rain + ' mm'],
  [/^([\d.,]+) mm effective rainfall · ([\d.,]+) mm net depth$/, (_, rain, depth) => '有効雨量 ' + rain + ' mm・正味必要水深 ' + depth + ' mm'],
  [/^Gross demand ([\d.,]+) m³, rounded up to the next whole m³ for planning\.$/, (_, volume) => '総需要量は' + volume + ' m³です。計画では1 m³単位に切り上げます。'],
  [/^Applied to the (west|east) sector\.$/, (_, side) => label(side) + '区画に適用しました。'],
  [/^Use for (west|east) sector$/, (_, side) => label(side) + '区画に適用'],
  [/^Pump ([\d.,]+) m³ before ([\d:]+)$/, (_, volume, hour) => hour + 'までに' + volume + ' m³揚水'],
  [/^Enter a whole number between 0 and ([\d.,]+)\.$/, (_, max) => '0～' + max + 'の整数を入力してください。'],
  [/^Enter a whole number from ([\d.,]+) to ([\d.,]+)\.$/, (_, min, max) => min + '～' + max + 'の整数を入力してください。'],
  [/^Previous result · (.+)$/, (_, scenario) => '前回の結果：' + label(scenario)],
  [/^([+−-]?[\d.,]+) pts minimum coverage · ([\d.,]+\s?%)$/, (_, change, result) => '最低充足率の変化 ' + change + 'ポイント・今回 ' + result],
  [/^Simulated plan approved at ([\d:]+) · Tunis time$/, (_, time) => 'シミュレーション計画を' + time + '（チュニス現地時間）に承認しました'],
  [/^Try the normal Jendouba day with a smaller 2 m³\/h pump, ([\d.,]+) m³ of stock and a ([\d.,]+) m³ withdrawal quota\.$/, (_, stock, quota) => 'ジェンドゥーバの通常日を、揚水能力2 m³/hの小型ポンプ、初期貯水量' + stock + ' m³、取水枠' + quota + ' m³で試します。'],
  [/^Actions before ([\w: ]+) were completed under the original plan\. Both alternatives resume with ([\d.,]+) m³ in the tank and ([\d.,]+) m³ of withdrawal quota\.$/, (_, hour, stock, quota) => hour + 'より前の作業は元の計画に沿って完了しました。両方の案を、貯水量' + stock + ' m³、残りの取水枠' + quota + ' m³で再開します。'],
  [/^(H?\d{2}(?::\d{2})?) · (Outage|Grid restored|Grid available|outage)( · pump shutdown)?$/, (_, time, state, shutdown) => time + '・' + label(state === 'outage' ? 'Outage' : state) + (shutdown ? '・ポンプ停止' : '')],
  [/^(Grid available|Grid restored|Outage) · pump shutdown$/, (_, state) => label(state) + '・ポンプ停止'],
  [/^(.*?) · Pumping ([\d.,]+ m³)$/, (_, time, amount) => time + '・揚水量 ' + amount],
  [/^([\w: ]+) · Plot ([\w-]+) · ([\d.,]+ m³)$/, (_, time, id, volume) => time + '・区画' + id + '・' + volume],
  [/^(.*?) · independent simulated readings$/, (_, time) => time + '・独立した模擬計測値'],
  [/^([\d.,]+ m³) of the stock available at ([\d:]+) must be available for use to meet the ([\d.,]+)% target by each deadline\. Surplus water may stay in the tank\. The withdrawal quota stays fixed\.$/, (_, volume, time, target) => '各期限までに目標充足率' + target + '%を達成するには、' + time + '時点で貯水のうち' + volume + 'を利用できる必要があります。余剰分は貯水槽に残せます。取水枠は一定です。'],
  [/^The solver proved that the ([\d.,]+)% target is unreachable with the available stock, quota and delivery windows\.$/, (_, target) => '現時点の貯水量、取水枠、配水時間帯では、目標充足率' + target + '%を達成できないことが計算で確認されました。'],
  [/^Fair plan coverage and deficit, with a separate feasibility verdict for the ([\d.,]+)% target$/, (_, target) => '公平配分計画の充足率と不足量、および目標充足率' + target + '%の達成可否'],
  [/^([\d:]+), (\d+) h, ([\d., %—]+) plan coverage, target: (Reachable|Unreachable|Unresolved|No parcel minimum)$/, (_, time, hours, coverage, state) => time + 'から' + hours + '時間・計画の充足率 ' + coverage + '・目標 ' + label(state)],
  [/^([\d.,]+) m³ short$/, (_, n) => n + ' m³不足'],
  [/^Longest tested cut meeting (\d+)%$/, (_, target) => '試算で目標充足率' + target + '%を達成できた最長停電時間'],
  [/^Reachable at ([\d, ]+) h$/, (_, hours) => hours + '時間の停電で達成可能'],
  [/^· unresolved at ([\d, ]+) h$/, (_, hours) => '・' + hours + '時間の停電は判定未確定'],
  [/^Heat day (\d+) · (Paced withdrawals|Use quota as needed)$/, (_, day, policy) => '猛暑' + day + '日目・' + label(policy)],
  [/^Every rule starts with the same stock and quota\. Urgency gives first priority to ([\w-]+)\.$/, (_, id) => 'すべてのルールで初期貯水量と取水枠は共通です。緊急優先ルールでは区画' + label(id) + 'を最優先します。'],
  [/^At the same quota the fair plan reaches ([\d., %—]+) coverage with prefill available and ([\d., %—]+) when earlier pumping is capped at the fixed-turn schedule\.$/, (_, prefill, limited) => '同じ取水枠での公平配分計画の充足率は、事前の貯水を許すと' + prefill + '、早めの揚水を固定輪番の上限に制限すると' + limited + 'です。'],
  [/^At ([\d:]+) the experiment introduces a ([\d.,]+) m³ disturbance\. Read the simulated tank state beside the instrument before choosing an inspection\.$/, (_, time, volume) => time + 'に' + volume + ' m³の異常を模擬します。点検方法を選ぶ前に、模擬貯水量と計器の表示を照合してください。'],
  [/^Each day uses ([\d.,]+)% of the entered demand\. Weather and outages repeat\. The end stock and remaining quota carry into the next day\.$/, (_, percent) => '各日の需要量を入力値の' + percent + '%とします。気象条件と停電は毎日同じで、日末の貯水量と残りの取水枠を翌日へ繰り越します。'],
  [/^The larger tank adds ([\d.,]+) m³ of capacity with the same initial water\. An islandable generator can power the pump at up to ([\d.,]+) W for every outage hour, assuming sufficient fuel throughout\. Grid-tied PV shuts down\. The household experiment uses a separate battery with a finite energy budget\.$/, (_, volume, power) => '初期貯水量を変えずに容量を' + volume + ' m³追加します。燃料が十分なら自立運転発電機は停電中、最大' + power + ' Wでポンプに給電します。系統連系の太陽光発電は停止します。家庭の試算には別の有限容量の蓄電池を使います。'],
  [/^reaches its deadline at the end of ([\d:]+) with ([\d.,]+) m³ still missing\. This is the earliest missed deadline in this replay\.$/, (_, slot, volume) => 'は' + slot + 'の時間枠終了時に' + volume + ' m³不足します。これはこの再生で最初に未達となる期限です。'],
  [/^(\d+) stress cases\. Select a cell to inspect its reachable reserve, hourly schedule and alternatives\. Short scenarios include only interruptions that fit the remaining horizon\.$/, (_, count) => count + '件の停電ケースがあります。マスを選ぶと、確保可能な予備水量、時間別計画、代替案を確認できます。短いシナリオでは、残り時間内に収まる停電だけを扱います。'],
  [/^Solving the ([\d:]+) interruption and checking alternatives…$/, (_, time) => time + 'からの停電を計算し、代替案を確認中…'],
  [/^(\d+) replay events$/, (_, count) => '再生中のイベント ' + count + '件'],
  [/^End-of-slot stock · ([\d.,]+ m³) capacity$/, (_, capacity) => '時間枠終了時の貯水量・容量 ' + capacity],
  [/^([\d.,]+ m³) pumped · ([\d.,]+ Wh)$/, (_, amount, energy) => '揚水量 ' + amount + '・消費電力量 ' + energy],
  [/^([\d.,]+ Wh) consumed this slot$/, (_, energy) => 'この時間枠の使用電力量 ' + energy],
  [/^([\d.,]+ Wh) used for pumping$/, (_, energy) => '揚水に使った電力量 ' + energy],
  [/^([\d.,]+\s?%) cumulative minimum coverage$/, (_, coverage) => 'ここまでの最低配水量の充足率 ' + coverage],
  [/^Inject a sensor fault at ([\d:]+)$/, (_, time) => time + 'にセンサーの異常を設定'],
  [/^Simulated load archive · issued 20 Nov 2026 at 18:00 Tunis time\. Held-out mean absolute error over ([\d.,]+) hours: ([\d.,]+) kW \(regression\), ([\d.,]+) kW \(same hour last week\)\.$/, (_, hours, regression, baseline) => '模擬負荷の記録・2026年11月20日18:00（チュニス現地時間）発行。検証用' + hours + '時間の平均絶対誤差は、回帰予測で' + regression + ' kW、前週同時刻を用いた予測で' + baseline + ' kWです。'],
  [/^Model an outage in (.+) for an independent residential circuit\. Enter the homes, essential loads and usable backup you want to test\. The irrigation pump uses a separate supply\.$/, (_, city) => city + 'の独立した住宅回路で停電を試算します。世帯数、必須負荷、使用できる非常電源を入力してください。灌漑ポンプは別電源です。'],
  [/^Replay the selected (\d+)-hour outage starting at ([\d:]+) for an independent residential circuit\. Enter the homes, essential loads and usable backup you want to test\. The irrigation pump uses a separate supply\.$/, (_, duration, start) => '独立した住宅回路で' + start + 'から' + duration + '時間の停電を再現します。世帯数、必須負荷、使用できる非常電源を入力してください。灌漑ポンプは別電源です。'],
  [/^First shortfall after (\d+) h (\d+) min$/, (_, hours, minutes) => '最初の電力不足は' + hours + '時間' + minutes + '分後'],
  [/^To cover every hour, this circuit needs ([\d.,]+ kWh) of usable energy and at least ([\d.,]+) W of island-capable output\.$/, (_, energy, power) => '全時間帯で給電するには、使用可能な電力量' + energy + 'と、自立運転時に少なくとも' + power + ' Wの出力が必要です。'],
  [/^((?:West sector|East sector|Plot [\w-]+) falls .+ short (?:with no eligible slot by|by the) [\s\S]+)$/, (_, content) => commitments(content)],
  [/^Scheduled deliveries from ([\d:]+)$/, (_, time) => time + '以降の配水予定'],
  [/^Deadline slot ([\d:]+)$/, (_, time) => '期限の時間枠 ' + time],
  [/^(\d+) of (\d+) assessed commitments met on time\.$/, (_, met, total) => '評価対象' + total + '件中、' + met + '件が期限内に達成されました。'],
  [/^Deadline readings cover (\d+) of (\d+) parcels\.$/, (_, measured, total) => '全' + total + '区画のうち、' + measured + '区画に期限時点の計測値があります。'],
  [/^Row (\d+): (.+ needs a non-negative volume in m³ with up to nine whole digits and three decimal places\.)$/, (_, row, detail) => row + '行目：' + detail.split(' ')[0] + 'には、整数部9桁以下、小数部3桁以下の0以上の水量（m³）を指定してください。'],
  [/^Row (\d+): (.+\.)$/, (_, row, detail) => row + '行目：' + label(detail)],
  [/^(\d+) reported hours · Peak irradiance ([\d.,]+) W\/m²\.$/, (_, count, peak) => '観測' + count + '時間・最大日射強度 ' + peak + ' W/m²。'],
  [/^Plot ([\w,-]+(?:, [\w-]+)*)$/, (_, id) => '区画' + id],
  [/^Parcel ([A-Z])$/, (_, id) => '区画' + id],
  [/^(Hour|Parcel|Pump requested \(m³\)|Delivery requested \(m³\)|Remove hour) (\d+)$/, (_, field, number) => label(field) + ' ' + number],
];
