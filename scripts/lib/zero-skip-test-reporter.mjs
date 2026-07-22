/**
 * Minimal node:test reporter for mandatory proof gates.
 *
 * Node's built-in human-readable output is not a stable programmatic API. This
 * reporter consumes the structured test event stream instead and makes any
 * skipped or TODO test fail the enclosing command. The proof runner therefore
 * cannot mistake an exit-zero partial test run for complete evidence.
 */
export default async function* zeroSkipTestReporter(source) {
  const summary = {
    passed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0
  };

  for await (const event of source) {
    if (event?.type !== "test:pass" && event?.type !== "test:fail") continue;
    const data = event.data || {};
    const skipped = data.skip != null && data.skip !== false;
    const todo = data.todo != null && data.todo !== false;
    if (skipped) summary.skipped += 1;
    if (todo) summary.todo += 1;
    if (event.type === "test:pass" && !skipped && !todo) {
      summary.passed += 1;
    }
    if (event.type === "test:fail") {
      if (data.details?.type === "cancelledByParent") summary.cancelled += 1;
      else summary.failed += 1;
    }
  }

  yield `${JSON.stringify({ reporter: "zero-skip-v1", ...summary })}\n`;
  if (summary.skipped > 0 || summary.todo > 0) process.exitCode = 1;
}
