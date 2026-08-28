export type FrozenToolShape = {
  required: string[];
  properties: Record<string, string>;
  widget?: string;
};

export type FrozenToolSnapshot = {
  schema_version: string;
  resource_uri_version: string;
  tools: Record<string, FrozenToolShape>;
};

export type ToolCompatibility = "CURRENT" | "BACKWARD_COMPATIBLE" | "MIGRATION_REQUIRED";

export function classifyToolCompatibility(current: any, previous: FrozenToolSnapshot): ToolCompatibility {
  if (major(current.schema_version) !== major(previous.schema_version) || current.resource_uri_version !== previous.resource_uri_version) return "MIGRATION_REQUIRED";
  const tools = new Map((current.tools as any[]).map((tool) => [tool.name, tool]));
  for (const [name, oldTool] of Object.entries(previous.tools)) {
    const next = tools.get(name);
    if (!next) return "MIGRATION_REQUIRED";
    const properties = next.input_schema?.properties ?? {};
    const required = new Set(next.input_schema?.required ?? []);
    for (const [property, type] of Object.entries(oldTool.properties)) {
      if (properties[property]?.type !== type) return "MIGRATION_REQUIRED";
      if (!oldTool.required.includes(property) && required.has(property)) return "MIGRATION_REQUIRED";
    }
    if (oldTool.widget !== next.widget) return "MIGRATION_REQUIRED";
  }
  return tools.size === Object.keys(previous.tools).length ? "CURRENT" : "BACKWARD_COMPATIBLE";
}

function major(version: string): string { return version.split(".")[0]; }
