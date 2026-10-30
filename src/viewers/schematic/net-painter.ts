/*
    Copyright (c) 2026 José Miguel Córdoba Méndez.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { BBox } from "../../base/math";
import { Circle, Polygon, Polyline, Renderer } from "../../graphics";
import type { SchematicTheme } from "../../kicad";
import * as schematic_items from "../../kicad/schematic";
import type {
    NetLabelItem,
    SchematicNet,
    SchematicNetlist,
} from "../../kicad/schematic-nets";
import { SchText } from "../../kicad/text";
import { get_symbol_body_and_pins_bbox } from "./painters/symbol";

/**
 * Where a label is, to pick it: its text, a margin around it, and for global
 * and hierarchical labels room for the shape. The layer bounding boxes are no
 * use here, they are not measured for labels.
 */
export function label_bbox(label: NetLabelItem): BBox {
    const text = new SchText(label.shown_text);
    text.apply_at(label.at);
    text.apply_effects(label.effects);
    const box = text.get_text_box();

    // relative to the anchor, for text that reads to the right
    const at = label.at.position;
    const x0 = box.x / 10000 - at.x;
    const y0 = box.y / 10000 - at.y;
    const x1 = x0 + box.w / 10000;
    const y1 = y0 + box.h / 10000;

    const size = label.effects.font.size.y;
    const pad =
        label instanceof schematic_items.NetLabel
            ? size * 0.5 + 0.3
            : size * 1.5 + 0.3;

    // vertical labels read upwards or downwards: turn the box
    const turned = label.at.rotation == 90 || label.at.rotation == 270;
    const [a, b, c, d] = turned ? [y0, -x1, y1, -x0] : [x0, y0, x1, y1];
    return BBox.from_corners(
        at.x + a! - pad,
        at.y + b! - pad,
        at.x + c! + pad,
        at.y + d! + pad,
        label,
    );
}

const power_boxes = new WeakMap<schematic_items.SchematicSymbol, BBox>();

/** Where a power symbol is: its body and pin, as drawn. */
export function power_symbol_bbox(
    theme: SchematicTheme,
    symbol: schematic_items.SchematicSymbol,
): BBox {
    let bbox = power_boxes.get(symbol);
    if (!bbox) {
        bbox = get_symbol_body_and_pins_bbox(theme, symbol);
        bbox.context = symbol;
        power_boxes.set(symbol, bbox);
    }
    return bbox;
}

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
    theme: SchematicTheme,
    netlist: SchematicNetlist,
    net: SchematicNet,
    sheet_path: string,
): number {
    const color = theme.brightened;
    const fill = color.with_alpha(0.25);
    const wire_width = 0.4;
    let count = 0;

    const box = (bbox: BBox) => {
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
                gfx.line(
                    new Polyline([segment.a, segment.b], wire_width, color),
                );
                gfx.circle(new Circle(segment.a, 0.6, color));
                count++;
            }
        } else if (item instanceof schematic_items.SchematicSheetPin) {
            gfx.circle(new Circle(item.at.position, 0.9, fill));
            gfx.circle(new Circle(item.at.position, 0.4, color));
            count++;
        } else if (item instanceof schematic_items.SchematicSymbol) {
            box(power_symbol_bbox(theme, item));
        } else {
            box(label_bbox(item));
        }
    }
    return count;
}
