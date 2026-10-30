# SAP integration — discovery requirements

Status: **DISCOVERY** (registry `sap`). No SAP code exists and none will be written until the questions below are
answered by SAG's SAP owner. Nothing in the app shows SAP as connected.

## 1. Product and landscape

| Question | Why it matters |
|---|---|
| Which product: S/4HANA Cloud Public Edition, S/4HANA Cloud Private Edition, S/4HANA on-premise, ECC 6.0, SAP Business One, SAP Business ByDesign? | Each has a different API surface and authentication |
| Version / release and support pack | Available OData services and fields differ by release |
| Systems: production, quality/test, sandbox client numbers | Development and tests run only against a non-production client |
| Which company codes, plants, storage locations, sales organisations exist, and which belong to which SAG unit (HQ, factory, branches)? | Becomes the unit ↔ SAP organisation mapping; franchise dealers are not expected to be in SAG's SAP |

## 2. APIs

| Question | Candidates (to confirm, not assumed) |
|---|---|
| Which interfaces are licensed and exposed? | OData v2/v4 (SAP API Business Hub services), BAPI/RFC, IDoc, SOAP, Business One Service Layer |
| Which business objects are needed first? | material stock, production orders / availability, sales orders, deliveries, customers (dealers) |
| Read-only first, or are writes wanted? | Writes (e.g. sales order, stock transfer) would go through the approval flow and idempotency keys |
| Rate limits, paging, change pointers / delta support | Decides sync design (full vs delta) |

## 3. Authentication (must be one the platform can store and rotate)

| Option | Typical for | Platform support today |
|---|---|---|
| OAuth 2.0 client credentials (SAP BTP / Cloud) | S/4HANA Cloud, BTP-exposed APIs | credential vault supports OAUTH2 storage; client-credentials flow not implemented |
| Basic auth with a technical communication user | on-premise / Communication Arrangements | API_KEY-style secret storage exists; would need a `sap` method mapping |
| X.509 client certificate | on-premise, Cloud Connector | not supported yet |
| SAML bearer / principal propagation | user-level calls | out of scope |

Required from SAP side: a dedicated technical user / communication arrangement with **least privilege** (read
roles for the chosen objects only), its expiry policy, and who rotates it.

## 4. Network

| Question | Why it matters |
|---|---|
| Is the API reachable from the internet (Render), or only inside SAG's network? | On-premise usually needs SAP Cloud Connector / VPN / a relay inside SAG |
| Fixed egress IPs required (allow-listing)? | Render egress IPs are shared; may need a relay |
| TLS certificates (public CA or internal)? | Internal CAs need trust configuration |

## 5. Data ownership and access

- SAP data belongs to the unit whose SAP organisation it is (mapping table, planned `erp_org_mappings`).
- Franchise dealers' private data is not expected in SAG's SAP; if dealer data exists there, sharing follows
  data-sharing agreements like every other class.
- Reporting currency UZS; SAP document currency and amounts kept as original values with the conversion rate.

## 6. Outcome of discovery → implementation plan

When answered: add a typed `sap` definition (AVAILABLE) with the confirmed auth method, read tools for the confirmed
objects, health check against a harmless endpoint, mapping table, and tests against a sandbox — never production.
