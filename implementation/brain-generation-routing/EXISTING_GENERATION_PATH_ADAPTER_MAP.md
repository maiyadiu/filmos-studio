# Existing Generation Path Adapter Map

| V2.4 layer | Reused path | Adapter responsibility |
|---|---|---|
| Composer | Canvas generation hooks/executors | Build draft and show exact resolved receipt/cost; no second executor. |
| Prompt compiler | Film prompt draft compiler + provider payload builders | Produce immutable compiled receipt before current submit. |
| Dreamina | local Dreamina services | Add catalogue/descriptor/authorization wrapper. |
| RunningHub | current channel/config path | Bind workflow descriptor and normalize receipt. |
| ComfyUI | current bridge/config path | Bind workflow descriptor and normalize receipt. |
| Manual | provider runtime manual path | Export package and require explicit result import. |
| Candidate import | generation artifact sink/materializer | Preserve Candidate-only boundary and lineage. |
