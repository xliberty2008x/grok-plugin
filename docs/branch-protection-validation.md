# Branch protection validation

This documentation-only change verifies that pull requests to `main` must
complete the aggregate hosted CI check, GitGuardian, and central Grok App review
before merge. The disposable probe does not alter runtime behavior.
