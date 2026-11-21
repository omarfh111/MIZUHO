# Mizu Nexus workbench tabs

All five tabs work with the bundled data. Open the workbench and use the default inputs to try each calculation.

| Tab | What it does |
| --- | --- |
| **Simulation** | Compare Jendouba, Kairouan, and Gabès under the same replay conditions. Inject **Pump inefficiency** to see only the selected station alert, or **Flow sensor dropout** to check how missing readings are handled. The **Virtual sensors** panel shows the latest measures and exports the replay. |
| **Solar comparison** | Uses saved PVGIS estimates to compare two 10 kWp installations. Compare savings by load and tariff, then click **Apply to simulation** to use an option’s solar profile in the Jendouba telemetry. |
| **Load forecast** | Choose a station and telemetry dataset. Press **Run forecast** to see its next 24 hours of electricity demand and the regression and baseline test errors. |
| **Anomaly checks** | Choose a station and use its energy reference. The stress test triggers both alert types. Routine irrigation has no injected faults. |
| **J+1 scenarios** | Choose **Cloud risk · seeded**, enter a seed, and press **Validate scenario** to replay a cloud-risk day. The adverse and stable reference cases are also available in the dropdown. |

See the [README](README.md) for launch instructions and connected feed setup.
