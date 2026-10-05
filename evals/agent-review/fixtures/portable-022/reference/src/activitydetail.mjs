function text(input, fields) {
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}
function commandText(input) {
  for (const field of ["command", "cmd"]) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}
function objectText(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  return text(value, fields);
}
function listText(input, listFields, itemFields) {
  for (const field of listFields) {
    const value = input[field];
    if (!Array.isArray(value)) {
      continue;
    }
    const items = value.map((entry) => typeof entry === "string" ? entry.trim() : objectText(entry, itemFields)).filter(Boolean);
    if (items.length) {
      return items.join("\n");
    }
  }
  return "";
}
function questionText(input) {
  return listText(input, ["questions"], ["question", "header"]);
}
function filesText(input) {
  return text(input, ["file_path", "filePath", "path"]) || listText(input, ["paths", "files", "referenced_image_paths"], ["file_path", "filePath", "path", "name"]);
}
function structuredListText(input) {
  return listText(input, ["findings", "todos"], ["title", "summary", "content", "message", "description"]);
}
function searchText(input) {
  return text(input, ["query", "prompt"]) || listText(input, ["queries"], []);
}
function webRequestText(input) {
  const collections = [
    ["search_query", ["q"]],
    ["image_query", ["q"]],
    ["open", ["ref_id"]],
    ["find", ["pattern"]],
    ["finance", ["ticker"]],
    ["weather", ["location"]],
    ["sports", ["team", "league"]],
    ["time", ["utc_offset"]]
  ];
  for (const [field, itemFields] of collections) {
    const value = listText(input, [field], itemFields);
    if (value) {
      return value;
    }
  }
  return "";
}
const NO_DETAIL = /* @__PURE__ */ new Set(["list_agents", "listagents", "update_plan", "wait", "wait_agent", "write_stdin"]);
const RULES = {
  bash: { policy: "required", format: "command", read: commandText },
  powershell: { policy: "required", format: "command", read: commandText },
  shell: { policy: "required", format: "command", read: commandText },
  exec: { policy: "required", format: "command", read: commandText },
  exec_command: { policy: "required", format: "command", read: commandText },
  read: { policy: "required", format: "path", read: filesText },
  edit: { policy: "required", format: "path", read: filesText },
  write: { policy: "required", format: "path", read: filesText },
  notebookedit: { policy: "required", format: "path", read: filesText },
  apply_patch: { policy: "required", format: "path", read: filesText },
  view_image: { policy: "required", format: "path", read: filesText },
  senduserfile: { policy: "required", format: "path", read: filesText },
  websearch: { policy: "required", format: "query", read: searchText },
  web_search: { policy: "required", format: "query", read: searchText },
  toolsearch: { policy: "required", format: "query", fields: ["query"] },
  webfetch: { policy: "required", format: "url", fields: ["url"] },
  web__run: { policy: "required", format: "query", read: webRequestText },
  sendmessage: { policy: "required", format: "prose", fields: ["recipient", "target", "to", "summary"] },
  send_message: { policy: "required", format: "prose", fields: ["target", "recipient", "to", "summary"] },
  followup_task: { policy: "required", format: "prose", fields: ["target", "recipient", "to", "summary"] },
  task: { policy: "required", format: "prose", fields: ["task_name", "description"] },
  agent: { policy: "required", format: "prose", fields: ["task_name", "description"] },
  spawn_agent: { policy: "required", format: "prose", fields: ["task_name", "description"] },
  skill: { policy: "required", format: "prose", fields: ["skill"] },
  taskoutput: { policy: "optional", format: "prose", fields: ["task_id"] },
  taskstop: { policy: "optional", format: "prose", fields: ["task_id"] },
  askuserquestion: { policy: "required", format: "prose", read: questionText },
  reportfindings: { policy: "optional", format: "prose", read: structuredListText },
  todowrite: { policy: "optional", format: "prose", read: structuredListText }
};
const SAFE_FIELDS = [
  "skill",
  "command",
  "cmd",
  "file_path",
  "filePath",
  "path",
  "url",
  "query",
  "pattern",
  "task_name",
  "recipient",
  "target",
  "to",
  "description",
  "prompt",
  "summary",
  "task_id"
];
function safeFallback(input) {
  return text(input, SAFE_FIELDS) || filesText(input) || questionText(input) || structuredListText(input) || webRequestText(input);
}
function activityDetail(toolName, input) {
  const normalized = toolName.toLowerCase();
  if (NO_DETAIL.has(normalized)) {
    return { policy: "none", format: "none", exact: "" };
  }
  const rule = RULES[normalized];
  if (!rule) {
    return { policy: "optional", format: "prose", exact: safeFallback(input) };
  }
  const exact = rule.read ? rule.read(input) : text(input, rule.fields ?? []);
  return { policy: rule.policy, format: rule.format, exact };
}
function describeToolInput(input) {
  return safeFallback(input);
}
export {
  activityDetail,
  describeToolInput
};
