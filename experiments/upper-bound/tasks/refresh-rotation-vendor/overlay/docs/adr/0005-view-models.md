# ADR 0005: View models without DOM access

Status: accepted

## Decision

Screens keep state in plain view-model classes under src/ui/ so they can be tested without a browser.
