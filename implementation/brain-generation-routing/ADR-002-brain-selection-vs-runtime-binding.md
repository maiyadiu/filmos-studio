# ADR-002 Brain Selection vs Runtime Binding

Status: Accepted. Selection resolves one of six profile IDs by explicit/project/global precedence. A separate exact lookup resolves its runtime binding. Missing bindings fail closed; no global `textModel`, channel-name, URL or model-name inference is allowed.
