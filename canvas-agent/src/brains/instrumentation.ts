export type AgentRuntimeCounters = {
    broker_request_count: number;
    broker_confirmation_count: number;
    broker_execute_count: number;
    legacy_direct_execute_count: number;
};

export class AgentRuntimeInstrumentation {
    private readonly counters: AgentRuntimeCounters = {
        broker_request_count: 0,
        broker_confirmation_count: 0,
        broker_execute_count: 0,
        legacy_direct_execute_count: 0,
    };

    brokerRequest() { this.counters.broker_request_count += 1; }
    brokerConfirmation() { this.counters.broker_confirmation_count += 1; }
    brokerExecute() { this.counters.broker_execute_count += 1; }
    legacyDirectExecute() { this.counters.legacy_direct_execute_count += 1; }
    snapshot(): AgentRuntimeCounters { return { ...this.counters }; }
}
