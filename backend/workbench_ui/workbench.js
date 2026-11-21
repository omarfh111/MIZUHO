const byId = (id) => document.getElementById(id);
const hour = (slot) => String(slot).padStart(2, "0") + " h";
const volume = (value) => value + " m³";
let scenario;
let result;
let selectedSlot;

function status(message, error = false) {
  byId("status").textContent = message;
  byId("status").classList.toggle("error", error);
}

function clearResults() {
  result = undefined;
  byId("results").hidden = true;
}

function setScenario(caseData, filename) {
  const slots = (caseData.scenario ?? caseData).slots;
  const firstSlot = caseData.state?.current_slot;
  if (!Array.isArray(slots) || !Number.isInteger(firstSlot)) {
    throw new Error("Le fichier doit inclure les créneaux et un état initial.");
  }
  const choices = slots.filter((slot) => slot.slot >= firstSlot && slot.grid_available === true);
  if (!choices.length) throw new Error("Aucun créneau disponible pour introduire une nouvelle coupure.");
  const select = byId("start");
  select.replaceChildren(...choices.map((slot) => new Option(hour(slot.slot), slot.slot)));
  const restoration = choices.find((slot) => slots[slot.slot - 1]?.grid_available === false);
  select.value = (restoration ?? choices[0]).slot;
  scenario = { caseData, lastSlot: slots.at(-1).slot };
  constrainDuration();
  byId("source").textContent = [filename, caseData.site_id, caseData.provenance === "simulated" ? "Scénario simulé" : caseData.provenance].filter(Boolean).join(" · ");
  byId("incident").hidden = false;
  clearResults();
  status("Prêt à calculer.");
}

function constrainDuration() {
  const input = byId("duration");
  input.max = scenario.lastSlot - Number(byId("start").value) + 1;
  if (input.valueAsNumber > Number(input.max)) input.value = input.max;
}

function metrics(container, entries) {
  container.replaceChildren(...entries.map(([label, value]) => {
    const box = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value;
    box.append(term, detail);
    return box;
  }));
}

function renderTimeline() {
  const mode = result[byId("mode").value];
  const rows = mode.slots;
  const buttons = rows.map((row) => {
    const bar = document.createElement("button");
    const height = document.createElement("span");
    height.style.height = (result.capacity_m3 ? row.tank_stock_m3 / result.capacity_m3 * 100 : 0) + "%";
    bar.type = "button";
    bar.classList.toggle("cut", !row.grid_available);
    bar.title = hour(row.slot) + " · " + volume(row.tank_stock_m3);
    bar.setAttribute("aria-label", bar.title);
    bar.append(height);
    bar.addEventListener("click", () => inspect(row, buttons));
    return bar;
  });
  byId("chart").replaceChildren(...buttons);
  inspect(rows.find((row) => row.slot === selectedSlot) ?? rows[0], buttons);
}

function inspect(row, buttons) {
  selectedSlot = row.slot;
  const rows = result[byId("mode").value].slots;
  buttons.forEach((button, index) => button.setAttribute("aria-pressed", rows[index].slot === selectedSlot));
  const deliveries = row.deliveries.map((delivery) => delivery.plot_id + " · " + volume(delivery.delivered_m3));
  byId("slot-detail").textContent = [hour(row.slot), row.grid_available ? "Réseau disponible" : "Coupure", ...deliveries].join(" — ");
  metrics(byId("slot-metrics"), [
    ["Stock avant → après", row.tank_stock_before_m3 + " → " + volume(row.tank_stock_m3)],
    ["Eau pompée", volume(row.pump_m3)],
    ["Eau livrée", volume(row.delivered_m3)],
    ["Quota restant", volume(row.quota_remaining_m3)],
    ["Énergie de la pompe", row.pump_wh + " Wh"],
  ]);
}

function renderAnalyses({ water, energy, equity }) {
  metrics(byId("analyses"), [
    ["Eau", water.balanced ? "Bilan conforme · " + volume(water.gravity_during_outages_m3) + " livrés en coupure" : "Écarts aux créneaux " + water.failed_slots.map(hour).join(", ")],
    ["Énergie", energy.balanced ? "Bilan conforme · " + energy.grid_wh + " Wh réseau" : "Écarts aux créneaux " + energy.failed_slots.map(hour).join(", ")],
    ["Équité · déficit total", volume(equity.reference_deficit_m3) + " → " + volume(equity.optimized_deficit_m3)],
  ]);
  byId("equity").replaceChildren(...equity.plots.map((plot) => {
    const row = document.createElement("tr");
    const label = document.createElement("th");
    label.scope = "row";
    label.textContent = plot.plot_id;
    row.append(label);
    for (const value of [plot.reference_deficit_m3, plot.optimized_deficit_m3]) {
      const cell = row.insertCell();
      cell.textContent = volume(value);
    }
    return row;
  }));
}

function message(detail) {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((error) => error.loc.join(".") + " — " + error.msg).join(" · ");
  if (detail?.stage) return "Calcul " + detail.stage + " · " + detail.status;
  return "Le service de calcul est indisponible.";
}

byId("incident").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearResults();
  status("Calcul du plan et des bilans en cours…");
  byId("solve").disabled = true;
  byId("file").disabled = true;
  byId("start").disabled = true;
  byId("duration").disabled = true;
  const first = Number(byId("start").value);
  const slots = Array.from({ length: byId("duration").valueAsNumber }, (_, index) => first + index);
  try {
    const response = await fetch("/api/incident", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ case: scenario.caseData, outage_slots: slots }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(message(body.detail));
    result = body;
    selectedSlot = first;
    byId("mode").value = "with_replan";
    renderTimeline();
    renderAnalyses(result.analyses);
    const checkpoint = result.checkpoint;
    const solveStatus = result.with_replan.status === "OPTIMAL" ? "Plan optimal" : "Plan faisable";
    status(solveStatus + " · " + result.runtime_ms + " ms · À " + hour(checkpoint.current_slot) + ", stock initial " + volume(checkpoint.tank_stock_m3) + " et quota " + volume(checkpoint.quota_remaining_m3));
    byId("results").hidden = false;
  } catch (error) {
    status(error.message, true);
  } finally {
    for (const id of ["solve", "file", "start", "duration"]) byId(id).disabled = false;
  }
});

byId("mode").addEventListener("change", renderTimeline);
byId("start").addEventListener("change", constrainDuration);
byId("file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    setScenario(JSON.parse(await file.text()), file.name);
  } catch (error) {
    status("Import impossible · " + error.message, true);
  }
});

byId("file").disabled = true;
fetch("/api/scenario").then(async (response) => {
  const body = await response.json();
  if (!response.ok) throw new Error(message(body.detail));
  if (body.case) setScenario(body.case, body.filename);
  else status("Importez un fichier de scénario pour commencer.");
}).catch((error) => status(error.message, true)).finally(() => { byId("file").disabled = false; });
