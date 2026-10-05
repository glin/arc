const RAIL_SORTS = ["latest", "cost-desc", "cost-asc", "needs-you"];
function normalizeRailSort(raw) {
  return RAIL_SORTS.includes(raw) ? raw : "latest";
}
function normalizeSavedViewSort(raw) {
  return raw === "inherit" ? raw : normalizeRailSort(raw) === raw ? raw : "inherit";
}
function railSortName(sort) {
  return {
    latest: "Latest update",
    "cost-desc": "Cost, highest first",
    "cost-asc": "Cost, lowest first",
    "needs-you": "Needs you first"
  }[sort];
}
function railSortShortName(sort) {
  return { latest: "Latest", "cost-desc": "Cost \u2193", "cost-asc": "Cost \u2191", "needs-you": "Needs you" }[sort];
}
export {
  RAIL_SORTS,
  normalizeRailSort,
  normalizeSavedViewSort,
  railSortName,
  railSortShortName
};
