# ADR-018 Budget Ledger and Events

Status: Accepted. Film Core has one mutable ledger per project/currency and immutable reservations/events. Reserve, release, expire, settle and adjust are atomic; UI never calculates authoritative balance.
