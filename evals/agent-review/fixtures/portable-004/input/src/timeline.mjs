export class SessionIndex {
  constructor() { this.sessions = new Map(); }
  async update(id, read) {
    let record;
    try { record = await read(); } catch { record = { cwd: null, bytes: 0 }; }
    this.sessions.set(id, { cwd: record.cwd, bytes: record.bytes });
    return this.sessions.get(id);
  }
}
