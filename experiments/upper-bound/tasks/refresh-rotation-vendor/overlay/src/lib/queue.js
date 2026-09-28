/** Runs async jobs one at a time, in order. */
export class SerialQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  push(job) {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => {});
    return run;
  }
}
