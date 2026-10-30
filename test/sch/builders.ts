/*
    Copyright (c) 2026 José Miguel Córdoba Méndez.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { KicadSch } from "../../src/kicad/schematic";
import { SchematicNetlist } from "../../src/kicad/schematic-nets";

// Small schematics written by hand: the numbers are chosen so that pins land
// where the wires are. A "Device:R" at (x, y) with no rotation has pin 1 at
// (x, y - 3.81) and pin 2 at (x, y + 3.81).

const FONT = "(effects (font (size 1.27 1.27)))";

function lib_symbols() {
    const pin = (type: string, at: string, name: string, number: string) =>
        `(pin ${type} line (at ${at}) (length 1.27)
            (name "${name}" ${FONT}) (number "${number}" ${FONT}))`;
    return `(lib_symbols
        (symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (in_bom yes) (on_board yes)
            (property "Reference" "R" (id 0) (at 2.032 0 90) ${FONT})
            (property "Value" "R" (id 1) (at 0 0 90) ${FONT})
            (symbol "R_0_1"
                (rectangle (start -1.016 -2.54) (end 1.016 2.54)
                    (stroke (width 0.254) (type default) (color 0 0 0 0))
                    (fill (type none))))
            (symbol "R_1_1"
                ${pin("passive", "0 3.81 270", "~", "1")}
                ${pin("passive", "0 -3.81 90", "~", "2")}))
        (symbol "Test:IC" (in_bom yes) (on_board yes)
            (property "Reference" "U" (id 0) (at 0 0 0) ${FONT})
            (property "Value" "IC" (id 1) (at 0 0 0) ${FONT})
            (symbol "IC_0_1"
                (rectangle (start -5.08 -2.54) (end 5.08 2.54)
                    (stroke (width 0.254) (type default) (color 0 0 0 0))
                    (fill (type none))))
            (symbol "IC_1_1"
                (pin power_in line (at 0 5.08 270) (length 2.54) hide
                    (name "VDD" ${FONT}) (number "1" ${FONT}))
                (pin input line (at -7.62 0 0) (length 2.54)
                    (name "IN" ${FONT}) (number "2" ${FONT}))))
        (symbol "power:GND" (power) (pin_names (offset 0)) (in_bom yes) (on_board yes)
            (property "Reference" "#PWR" (id 0) (at 0 0 0) ${FONT})
            (property "Value" "GND" (id 1) (at 0 0 0) ${FONT})
            (symbol "GND_0_1"
                (polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27))
                    (stroke (width 0) (type default) (color 0 0 0 0))
                    (fill (type none))))
            (symbol "GND_1_1"
                (pin power_in line (at 0 0 270) (length 0) hide
                    (name "GND" ${FONT}) (number "1" ${FONT})))))`;
}

let uuid_counter = 0;
export const uuid = () =>
    `00000000-0000-4000-8000-${String(++uuid_counter).padStart(12, "0")}`;

export const wire = (x1: number, y1: number, x2: number, y2: number) =>
    `(wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2}))
        (stroke (width 0) (type default) (color 0 0 0 0)) (uuid ${uuid()}))`;

export const bus = (x1: number, y1: number, x2: number, y2: number) =>
    `(bus (pts (xy ${x1} ${y1}) (xy ${x2} ${y2}))
        (stroke (width 0) (type default) (color 0 0 0 0)) (uuid ${uuid()}))`;

export const junction = (x: number, y: number) =>
    `(junction (at ${x} ${y}) (diameter 0) (color 0 0 0 0) (uuid ${uuid()}))`;

export const label = (text: string, x: number, y: number) =>
    `(label "${text}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid ${uuid()}))`;

export const global_label = (text: string, x: number, y: number) =>
    `(global_label "${text}" (shape input) (at ${x} ${y} 0)
        (effects (font (size 1.27 1.27)) (justify left)) (uuid ${uuid()}))`;

export const hier_label = (text: string, x: number, y: number) =>
    `(hierarchical_label "${text}" (shape input) (at ${x} ${y} 0)
        (effects (font (size 1.27 1.27)) (justify left)) (uuid ${uuid()}))`;

export function symbol(
    lib_id: string,
    reference: string,
    value: string,
    x: number,
    y: number,
    rotation = 0,
    extra = "",
    pins = ["1", "2"],
) {
    return `(symbol (lib_id "${lib_id}") (at ${x} ${y} ${rotation}) ${extra} (unit 1)
        (in_bom yes) (on_board yes) (uuid ${uuid()})
        (property "Reference" "${reference}" (id 0) (at ${x} ${y} 0) ${FONT})
        (property "Value" "${value}" (id 1) (at ${x} ${y} 0) ${FONT})
        ${pins.map((n) => `(pin "${n}" (uuid ${uuid()}))`).join(" ")})`;
}

export const resistor = (
    ref: string,
    x: number,
    y: number,
    rotation = 0,
    extra = "",
) => symbol("Device:R", ref, "10k", x, y, rotation, extra);

export const gnd = (x: number, y: number) =>
    symbol("power:GND", "#PWR01", "GND", x, y, 0, "", ["1"]);

export function sheet_block(
    name: string,
    file: string,
    sheet_uuid: string,
    x: number,
    y: number,
    pins: [string, number, number][],
) {
    return `(sheet (at ${x} ${y}) (size 20 20) (fields_autoplaced)
        (stroke (width 0.1524) (type solid) (color 0 0 0 0))
        (fill (color 0 0 0 0.0000)) (uuid ${sheet_uuid})
        (property "Sheet name" "${name}" (id 0) (at ${x} ${y - 1} 0) ${FONT})
        (property "Sheet file" "${file}" (id 1) (at ${x} ${y + 21} 0) ${FONT})
        ${pins
            .map(
                ([n, px, py]) =>
                    `(pin "${n}" input (at ${px} ${py} 180) ${FONT} (uuid ${uuid()}))`,
            )
            .join(" ")})`;
}

export function schematic(root_uuid: string, ...items: string[]) {
    return new KicadSch(
        "test.kicad_sch",
        `(kicad_sch (version 20211123) (generator "eeschema") (uuid ${root_uuid})
            (paper "A4")
            ${lib_symbols()}
            ${items.join("\n")})`,
    );
}

export const ROOT = "11111111-1111-4111-8111-111111111111";
export const SUB = "22222222-2222-4222-8222-222222222222";

export function single(...items: string[]) {
    const doc = schematic(ROOT, ...items);
    return { doc, netlist: new SchematicNetlist([{ path: `/${ROOT}`, doc }]) };
}

