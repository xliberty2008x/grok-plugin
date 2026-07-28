Your previous response was not valid Grok Review App JSON. Return only one JSON
object with exactly `summary` and `findings`. Each finding may optionally include
a `suggestion` object with exactly `startLine`, `endLine`, and `replacement`.
Omit `verdict`; the runtime derives pass from zero findings and needs_changes
from one or more findings. Preserve substantive findings, use repository-relative
paths, and keep suggestion ranges on the RIGHT side of the diff when present.
