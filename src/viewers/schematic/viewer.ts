/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { first } from "../../base/iterator";
import { BBox, Vec2 } from "../../base/math";
import { is_string } from "../../base/types";
import { Renderer } from "../../graphics";
import { Canvas2DRenderer } from "../../graphics/canvas2d";
import type { SchematicTheme } from "../../kicad";
import {
    Bus,
    GlobalLabel,
    HierarchicalLabel,
    Junction,
    KicadSch,
    NetLabel,
    PinInstance,
    SchematicSheet,
    SchematicSheetPin,
    SchematicSymbol,
    Wire,
} from "../../kicad/schematic";
import {
    netlist_for,
    parse_netlist,
    type SchematicNet,
    type SchematicNetlist,
} from "../../kicad/schematic-nets";
import type { ProjectPage } from "../../kicanvas/project";
import { DocumentViewer } from "../base/document-viewer";
import { KiCanvasNetHighlightEvent } from "../base/events";
import type { ViewLayerSet } from "../base/view-layers";
import { LayerNames, LayerSet } from "./layers";
import { label_bbox, paint_net, power_symbol_bbox } from "./net-painter";
import { SchematicPainter } from "./painter";

/** Items that belong to a net and can be picked on the sheet. */
export type NetPickable =
    | Wire
    | Bus
    | Junction
    | NetLabel
    | GlobalLabel
    | HierarchicalLabel
    | SchematicSheetPin
    | PinInstance;

// How close to an item a click has to land, in screen pixels.
const PICK_RADIUS_PX = 4;

export class SchematicViewer extends DocumentViewer<
    KicadSch,
    SchematicPainter,
    LayerSet,
    SchematicTheme
> {
    /**
     * The hierarchical path of the sheet instance being shown ("/<root uuid>"
     * for the root sheet). A sheet file used more than once is a different
     * set of nets for each use. The app sets it when it opens a project page;
     * when it is not set, the first use of the document is assumed.
     */
    public sheet_path?: string;

    #highlighted: SchematicNet | null = null;

    get schematic(): KicadSch {
        return this.document;
    }

    /** The connectivity of the schematic (the whole project, if it has one). */
    get netlist(): SchematicNetlist {
        return netlist_for(this.document);
    }

    /** The sheet instance being shown. */
    get current_sheet_path(): string {
        const netlist = this.netlist;
        if (this.sheet_path && netlist.sheet_paths.includes(this.sheet_path)) {
            return this.sheet_path;
        }
        return netlist.paths_of(this.document)[0] ?? "";
    }

    /**
     * Names the nets as a netlist exported by KiCad does, for the nets that
     * have pins (see the notes in kicad/schematic-nets.ts about how nets are
     * named without it).
     *
     * @param netlist - the text of `kicad-cli sch export netlist`
     * @returns how many nets changed their name
     */
    public apply_netlist(netlist: string): number {
        return this.netlist.apply_names(parse_netlist(netlist));
    }

    /** The net a wire, label, pin, junction or power symbol is part of. */
    net_of(item: unknown): SchematicNet | null {
        if (!this.document || !item) {
            return null;
        }
        return this.netlist.net_of(this.current_sheet_path, item);
    }

    /** The net currently highlighted, if any. */
    get highlighted_net(): SchematicNet | null {
        return this.#highlighted;
    }

    override create_renderer(canvas: HTMLCanvasElement): Renderer {
        const renderer = new Canvas2DRenderer(canvas);
        renderer.state.fill = this.theme.note;
        renderer.state.stroke = this.theme.note;
        renderer.state.stroke_width = 0.1524;
        return renderer;
    }

    override async load(src: KicadSch | ProjectPage) {
        if (src instanceof KicadSch) {
            return await super.load(src);
        }

        this.document = null!;

        const doc = src.document as KicadSch;
        doc.update_hierarchical_data(src.sheet_path);

        return await super.load(doc);
    }

    protected override create_painter() {
        return new SchematicPainter(this.renderer, this.layers, this.theme);
    }

    protected override create_layer_set() {
        return new LayerSet(this.theme);
    }

    public override paint() {
        super.paint();
        this.#paint_net();
    }

    protected override on_pick(
        mouse: Vec2,
        items: ReturnType<ViewLayerSet["query_point"]>,
    ) {
        const hit = this.#net_at(mouse);
        if (hit) {
            this.select(hit.item as NetPickable | SchematicSymbol);
            this.highlight_net(hit.net);
            return;
        }

        super.on_pick(mouse, items);

        // Picking something that is not a net, or nothing, clears the net.
        if (this.#highlighted) {
            this.highlight_net(null);
        }
    }

    /** The wire, label, pin, power symbol... under the mouse, and its net. */
    #net_at(mouse: Vec2): { item: unknown; net: SchematicNet } | null {
        if (!this.document) {
            return null;
        }
        const path = this.current_sheet_path;
        const netlist = this.netlist;

        // Labels and power symbols are as big as they are drawn.
        const labels = [
            ...this.document.net_labels,
            ...this.document.global_labels,
            ...this.document.hierarchical_labels,
        ];
        for (const item of labels) {
            const net = netlist.net_of(path, item);
            if (net && label_bbox(item).contains_point(mouse)) {
                return { item, net };
            }
        }
        for (const item of this.document.symbols.values()) {
            const net = netlist.net_of(path, item);
            if (
                net &&
                power_symbol_bbox(this.theme, item)
                    .copy()
                    .grow(0.3)
                    .contains_point(mouse)
            ) {
                return { item, net };
            }
        }

        const tolerance = Math.max(
            0.25,
            PICK_RADIUS_PX / this.viewport.camera.zoom,
        );
        return netlist.pick(path, mouse, tolerance);
    }

    /**
     * Highlights a net on this sheet and dims the rest, like the board
     * viewer's highlight_net. The net stays highlighted when another sheet is
     * opened, so it can be followed through the hierarchy. Pass null to clear.
     *
     * @param net - a net of this schematic's netlist, or its name
     */
    public highlight_net(net: SchematicNet | string | null) {
        const found = is_string(net)
            ? (this.netlist.net_by_name(net) ?? null)
            : net;
        this.#highlighted = found;
        this.#paint_net();
        this.draw();
        this.dispatchEvent(new KiCanvasNetHighlightEvent({ net: found }));
    }

    #paint_net() {
        const layer = this.layers?.by_name(LayerNames.net_highlight);
        if (!layer) {
            return;
        }
        layer.clear();
        layer.highlighted = false;

        const net = this.#highlighted;
        if (!net || !this.document) {
            return;
        }

        this.renderer.start_layer(layer.name);
        const count = paint_net(
            this.renderer,
            this.theme,
            this.netlist,
            net,
            this.current_sheet_path,
        );
        layer.graphics = this.renderer.end_layer();

        // The viewer dims every layer that is not highlighted. A net that is
        // not on this sheet has nothing to show, so nothing is dimmed.
        layer.highlighted = count > 0;
    }

    // Wires and pins have no box worth drawing: the net highlight shows them.
    protected override paint_selected() {
        const selected = this.selected?.context;
        if (
            selected &&
            !(
                selected instanceof SchematicSymbol ||
                selected instanceof SchematicSheet
            )
        ) {
            this.layers.overlay.clear();
            this.draw();
            return;
        }
        super.paint_selected();
    }

    // Power symbols are not on the interactive layer, they are found by how
    // they are drawn.
    #drawn_bbox(item: SchematicSymbol | SchematicSheet): BBox | null {
        if (item instanceof SchematicSymbol && this.net_of(item)) {
            return power_symbol_bbox(this.theme, item).copy();
        }
        return null;
    }

    /** Draws the highlighted net again, after the sheet shown changed. */
    public refresh_net() {
        this.#paint_net();
        this.draw();
    }

    /** Where an item that belongs to a net is, as a box to select. */
    #net_item_bbox(item: unknown): BBox | null {
        const path = this.current_sheet_path;
        const grow = (points: Vec2[], by: number) =>
            BBox.from_points(points, item).grow(by);
        if (item instanceof Wire || item instanceof Bus) {
            return grow(item.pts, 0.5);
        }
        if (item instanceof Junction) {
            return grow([item.at.position], 0.5);
        }
        if (item instanceof SchematicSheetPin) {
            return grow([item.at.position], 1);
        }
        if (item instanceof PinInstance) {
            const segment = this.netlist.pin_segment(path, item);
            return segment ? grow([segment.a, segment.b], 0.5) : null;
        }
        if (
            item instanceof NetLabel ||
            item instanceof GlobalLabel ||
            item instanceof HierarchicalLabel
        ) {
            return label_bbox(item);
        }
        return null;
    }

    public override select(
        item:
            | SchematicSymbol
            | SchematicSheet
            | NetPickable
            | string
            | BBox
            | null,
    ): void {
        // If item is a string, find the symbol by uuid or reference.
        if (is_string(item)) {
            item =
                this.schematic.find_symbol(item) ??
                this.schematic.find_sheet(item);
        }

        // If it's a symbol or sheet, find the bounding box for it.
        if (item instanceof SchematicSymbol || item instanceof SchematicSheet) {
            const bboxes = this.layers.query_item_bboxes(item);
            item = first(bboxes) ?? this.#drawn_bbox(item);
        } else if (item != null && !(item instanceof BBox)) {
            // Wires, labels, pins... select with the item as the context.
            item = this.#net_item_bbox(item);
        }

        super.select(item);
    }
}
