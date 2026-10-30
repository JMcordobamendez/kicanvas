/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { SchematicViewer } from "../../../viewers/schematic/viewer";
import type { ProjectPage } from "../../project";
import { KCViewerElement } from "../common/viewer";

export class KCSchematicViewerElement extends KCViewerElement<SchematicViewer> {
    protected override update_theme(): void {
        this.viewer.theme = this.themeObject.schematic;
    }

    protected override make_viewer(): SchematicViewer {
        return new SchematicViewer(
            this.canvas,
            !this.disableinteraction,
            this.themeObject.schematic,
        );
    }

    override async load(src: ProjectPage) {
        // The viewer needs to know which use of the sheet it is showing to
        // tell its nets apart, a sheet file can be used more than once.
        const same_document = this.viewer.document === src.document;
        this.viewer.sheet_path = src.sheet_path;
        await super.load(src);
        if (same_document) {
            this.viewer.refresh_net();
        }
    }
}

window.customElements.define("kc-schematic-viewer", KCSchematicViewerElement);
