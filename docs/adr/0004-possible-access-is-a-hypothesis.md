# ADR 0004: IAM permission is not a runtime dependency

Status: accepted

An IAM allow statement proves potential authorization, not use. Such edges are recorded as `possible-access` with confidence `hypothesis`, never count as structure when forming application candidates, and raise a question when nothing else corroborates them. The same caution applies to naming conventions and tags. Statements are never removed from generated policies on the strength of this analysis.
