export class SpendIndex {
  constructor(recompute) { this.recompute = recompute; this.stamp = null; }
  onFile(file) {
    const stamp = file.path + ':' + file.size + ':' + file.modifiedAt;
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.recompute(file);
  }
}
