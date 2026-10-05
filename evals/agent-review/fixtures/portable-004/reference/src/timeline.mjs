export class SessionIndex {
  constructor() { this.sessions = new Map(); }
  async update(id, read) {
    let record;
    try { record = await read(); } catch { return this.sessions.get(id) ?? null; }
    this.sessions.set(id, { cwd: record.cwd, bytes: record.bytes });
    return this.sessions.get(id);
  }
}
