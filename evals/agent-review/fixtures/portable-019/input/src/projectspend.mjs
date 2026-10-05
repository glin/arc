export class SpendRefresher {
  constructor(scan) { this.scan=scan; this.known=new Map(); }
  notify(file) {
    const signature=file.bytes + ':' + file.modifiedAt;
    if (this.known.get(file.path)===signature) return false;
    this.known.set(file.path,signature);
    this.scan(file);
    return true;
  }
}
