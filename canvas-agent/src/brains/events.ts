import type { AgentEventSink, NormalizedBrainEvent } from "./contracts.js";

export class BrainEventBus {
    private readonly sinks = new Set<AgentEventSink>();

    subscribe(sink: AgentEventSink) {
        this.sinks.add(sink);
        return () => this.sinks.delete(sink);
    }

    async emit(event: NormalizedBrainEvent) {
        await Promise.all([...this.sinks].map(async (sink) => await sink(structuredClone(event))));
    }
}
