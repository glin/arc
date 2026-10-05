import { timingRecord } from './protocol.mjs';
export class DiagnosticsStore {
  constructor() { this.rows=[]; }
  accept(message) {
    const row=timingRecord(message);
    if (row) this.rows.push(row);
  }
  exportText() { return this.rows.map(row=>JSON.stringify(row)).join('\n'); }
}
