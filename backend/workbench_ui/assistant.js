const byId = (id) => document.getElementById(id);
let previousQuestion = "";

function status(value, error = false) {
  byId("assistant-status").textContent = value;
  byId("assistant-status").classList.toggle("error", error);
}

function link(source, label) {
  const element = document.createElement("a");
  const url = new URL(source.url);
  if (url.protocol !== "https:") throw new Error("Lien de source invalide.");
  if (source.page) url.hash = "page=" + source.page;
  element.href = url.href;
  element.textContent = label;
  element.target = "_blank";
  element.rel = "noopener noreferrer";
  return element;
}

function addMessage(role, text) {
  const article = document.createElement("article");
  article.className = "message " + role;
  const heading = document.createElement("strong");
  heading.textContent = role === "user" ? "Vous" : "MIZUHO";
  const body = document.createElement("p");
  body.textContent = text;
  article.append(heading, body);
  byId("messages").append(article);
  return article;
}

function showReply(reply) {
  const article = addMessage("assistant", reply.answer);
  if (reply.sources.length) {
    const references = document.createElement("ol");
    for (const source of reply.sources) {
      const row = document.createElement("li");
      row.append(link(source, "[" + source.id + "] " + source.title + " · " + source.publisher + " · p. " + source.page));
      references.append(row);
    }
    article.append(references);
  }
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Parcours documentaire";
  const trace = document.createElement("ul");
  for (const path of reply.routing) {
    const row = document.createElement("li");
    row.textContent = "Coordination → " + path.theme + " → " + path.specialist + " · " + path.index + " · " + path.matches + " correspondances";
    trace.append(row);
  }
  details.append(summary, trace);
  article.append(details);
}

for (const example of document.querySelectorAll(".examples button")) {
  example.addEventListener("click", () => {
    byId("question").value = example.textContent.trim();
    byId("question").focus();
  });
}

byId("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = byId("question").value.trim();
  if (question.length < 3) return;
  byId("send").disabled = true;
  addMessage("user", question);
  status("Consultation du corpus…");
  try {
    const response = await fetch("/api/assistant/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, previous_question: previousQuestion }),
    });
    const reply = await response.json();
    if (!response.ok) throw new Error(typeof reply.detail === "string" ? reply.detail : "Le service documentaire est indisponible.");
    showReply(reply);
    if (reply.sources.length) previousQuestion = question;
    if (byId("question").value.trim() === question) byId("question").value = "";
    status("");
  } catch (error) {
    status(error.message, true);
  } finally {
    byId("send").disabled = false;
  }
});

fetch("/api/assistant/sources").then(async (response) => {
  if (!response.ok) throw new Error("Inventaire des sources indisponible.");
  const catalog = await response.json();
  if (!catalog.ready) {
    byId("index-status").textContent = "Le corpus est en cours de préparation.";
    return;
  }
  byId("index-status").textContent = catalog.sources.length + " publications · " + (catalog.qdrant_indexed ? "Index Qdrant" : "Index local");
  for (const source of catalog.sources) {
    const entry = document.createElement("li");
    entry.append(link(source, source.title + " · " + source.publisher));
    byId("catalog").append(entry);
  }
}).catch((error) => { byId("index-status").textContent = error.message; });
