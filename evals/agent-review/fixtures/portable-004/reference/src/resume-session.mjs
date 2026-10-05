import { SessionIndex } from './timeline.mjs';
export class ResumeSession {
  constructor() { this.index=new SessionIndex(); }
  async update(id,read) { return this.index.update(id,read); }
  command(id) {
    const cwd=this.index.sessions.get(id)?.cwd;
    return cwd ? {cwd,args:['resume',id]} : null;
  }
}
