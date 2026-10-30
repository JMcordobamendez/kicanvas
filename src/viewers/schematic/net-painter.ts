/*
    Copyright (c) 2026 José Miguel Córdoba Méndez.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import type { BBox } from "../../base/math";
import { Circle, Polygon, Polyline, Renderer } from "../../graphics";
import type { SchematicTheme } from "../../kicad";
import * as schematic_items from "../../kicad/schematic";
import type {
    SchematicNet,
    SchematicNetlist,
} from "../../kicad/schematic-nets";
import { LayerNames, type LayerSet } from "./layers";

/**
 * Draws a net on top of a schematic sheet: its wires, buses, junctions and
 * pins thicker and in the theme's "brightened" color, a box around its labels
 * and power symbols. The layer it is drawn on is highlighted by the caller,
 * which makes the viewer dim everything else.
 *
 * @returns how many items were drawn.
 */
export function paint_net(
    gfx: Renderer,
    layers: LayerSet,
    theme: SchematicTheme,
    netlist: SchematicNetlist,
    net: SchematicNet,
    sheet_path: string,
): number {
    const color = theme.brightened;
    const fill = color.with_alpha(0.25);
    const wire_width = 0.4;
    let count = 0;

    const box = (bbox: BBox | undefined) => {
        if (!bbox) {
            return;
        }
        const bb = bbox.copy().grow(0.5);
        gfx.polygon(Polygon.from_BBox(bb, fill));
        gfx.line(Polyline.from_BBox(bb, 0.2, color));
        count++;
    };

    for (const item of net.items_on(sheet_path)) {
        if (item instanceof schematic_items.Wire) {
            gfx.line(new Polyline(item.pts, wire_width, color));
            count++;
        } else if (item instanceof schematic_items.Bus) {
            gfx.line(new Polyline(item.pts, wire_width * 2, color));
            count++;
        } else if (item instanceof schematic_items.Junction) {
            const radius = Math.max((item.diameter || 0) / 2, 0.5);
            gfx.circle(new Circle(item.at.position, radius, color));
            count++;
        } else if (item instanceof schematic_items.PinInstance) {
            const segment = netlist.pin_segment(sheet_path, item);
            if (segment) {
                gfx.line(new Polyline([segment.a, segment.b], wire_width, color));
                gfx.circle(new Circle(segment.a, 0.6, color));
                count++;
            }
        } else if (item instanceof schematic_items.SchematicSheetPin) {
            gfx.circle(new Circle(item.at.position, 0.9, fill));
            gfx.circle(new Circle(item.at.position, 0.4, color));
            count++;
        } else if (item instanceof schematic_items.SchematicSymbol) {
            // power symbols
            box(layers.by_name(LayerNames.symbol_foreground)?.bboxes.get(item));
        } else {
            // labels
            box(layers.by_name(LayerNames.label)?.bboxes.get(item));
        }
    }
    return count;
}
