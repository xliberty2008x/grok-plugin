/**
 * @typedef {{ severity: string, title: string, body: string, file?: string|null, line?: number|null }} Finding
 * @typedef {{ skip: true, reason: string } | { skip: false, payload: object }} BuildResult
 */

/**
 * Map companion public job JSON + right-side diff lines to a GitHub create-review body.
 * @param {{ job: object, headSha: string, rightSideLines: Set<string> }} args
 * @returns {BuildResult}
 */
export function buildPrReviewPayload({ job, headSha, rightSideLines }) {
  if (!headSha || typeof headSha !== "string") {
    throw new Error("headSha is required");
  }
  const result = job?.result || null;
  if (result?.skipped && result?.skipReason === "empty-target") {
    return { skip: true, reason: "empty-target" };
  }
  const review = result?.review;
  if (!review || typeof review !== "object") {
    throw new Error("Job JSON missing result.review (review may have failed before completion)");
  }
  const findings = Array.isArray(review.findings) ? review.findings : [];
  if (findings.length === 0) {
    return { skip: true, reason: "no-findings" };
  }

  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const inline = [];
  const promoted = [];

  for (const f of findings) {
    const severity = String(f.severity || "info");
    if (Object.hasOwn(counts, severity)) counts[severity] += 1;
    else counts.info += 1;

    const file = f.file == null || f.file === "" ? null : String(f.file);
    const line = f.line == null ? null : Number(f.line);
    const key = file && line && Number.isFinite(line) ? `${file}:${line}` : null;
    const commentBody = formatFindingComment(f);

    if (key && rightSideLines.has(key)) {
      inline.push({
        path: file,
        line,
        side: "RIGHT",
        body: commentBody
      });
    } else {
      promoted.push({ severity, file, line, title: f.title, body: f.body });
    }
  }

  const bodyParts = [
    "## Grok review",
    "",
    String(review.summary || "").trim() || "(no summary)",
    "",
    "## Issue counts by severity",
    "",
    `- critical: ${counts.critical}`,
    `- high: ${counts.high}`,
    `- medium: ${counts.medium}`,
    `- low: ${counts.low}`,
    `- info: ${counts.info}`,
    ""
  ];

  if (promoted.length) {
    bodyParts.push("## Issues outside the diff", "");
    for (const p of promoted) {
      const loc =
        p.file && p.line
          ? `${p.file}:${p.line}`
          : p.file
            ? p.file
            : "(no location)";
      bodyParts.push(`- **[${p.severity}]** ${loc} — ${p.title}`);
      bodyParts.push(`  ${p.body}`);
      bodyParts.push("");
    }
  }

  bodyParts.push(
    "---",
    "",
    "_Automated Superpowers-style Grok Companion review (informational; does not block merge)._"
  );

  return {
    skip: false,
    payload: {
      commit_id: headSha,
      event: "COMMENT",
      body: bodyParts.join("\n"),
      comments: inline
    }
  };
}

function formatFindingComment(f) {
  const title = String(f.title || "Finding").trim();
  const body = String(f.body || "").trim();
  const severity = String(f.severity || "info");
  return `**[${severity}] ${title}**\n\n${body}`;
}
