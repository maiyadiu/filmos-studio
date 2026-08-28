import { filmosToolContract } from "@filmos/tool-contracts";

import { inspectSecureTunnel } from "./tunnel.js";

const tunnel = await inspectSecureTunnel();
process.stdout.write(`${JSON.stringify({
  kind: "FILMOS_CHATGPT_DOCTOR",
  contract_id: filmosToolContract.contract_id,
  contract_hash: filmosToolContract.contract_hash,
  public_tool_count: filmosToolContract.tools.length,
  reserved_write_tools_registered: 0,
  tunnel,
}, null, 2)}\n`);
