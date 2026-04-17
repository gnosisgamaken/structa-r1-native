# structa client/server protection

## doctrine

anything shipped to the browser is public.

- javascript, html, svg, and local storage formats are inspectable
- frontend code is a product surface, not a secret vault
- real protection comes from moving harnessing quality behind a service you control

## what stays client-side

- state machine and surface rendering
- hardware routing
- immediate camera open/close and preview storage
- local-first project memory
- probe mode and local logs
- rabbit bridge wrappers

## what moved behind the service

- voice interpretation prompt assembly
- image analysis prompt assembly
- chain-step prompt assembly
- triangle synthesis prompt assembly
- normalization of raw llm output into compact artifacts

## why this shape

structa still runs its actual rabbit llm call on-device, because that bridge is device-bound.
the service prepares prompts and normalizes outputs, so the high-value harnessing logic is no longer embedded in the shipped client bundle.

## service endpoints

- `POST /v1/voice/interpret`
- `POST /v1/image/analyze`
- `POST /v1/chain/step`
- `POST /v1/triangle/synthesize`

each endpoint supports:

- prepare mode: client sends normalized context, service returns `llm`
- normalize mode: client sends the raw llm response, service returns compact artifacts

## privacy posture

- raw project memory stays local by default
- only minimum derived context is sent to the service
- persistence on the service is not required for stage 1 or stage 2

