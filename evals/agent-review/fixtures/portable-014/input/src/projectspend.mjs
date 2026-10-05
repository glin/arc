export class SpendIndex {
  constructor(recompute) { this.recompute = recompute; this.stamp = null; }
  onFile(file) {
    const stamp = file.path + ':' + file.size + ':' + file.modifiedAt;
    this.stamp = stamp;
    this.recompute(file);
  }
}
