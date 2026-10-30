/*
    Copyright (c) 2026 José Miguel Córdoba Méndez.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Vec2 } from "../base/math";
import { basename, dirname, normalize_join } from "../base/paths";
import type { Project } from "../kicanvas/project";
import type {
    Bus,
    GlobalLabel,
    HierarchicalLabel,
    Junction,
    KicadSch,
    NetLabel,
    PinInstance,
    SchematicSheetPin,
    SchematicSymbol,
    Wire,
} from "./schematic";
import { listify, type List } from "./tokenizer";

/**
 * Schematic connectivity.
 *
 * KiCanvas draws schematics, it does not know which pins and wires are
 * electrically connected. This module works that out, following the rules of
 * KiCad's connection graph (SCH_CONNECTION_GRAPH) as far as they matter for
 * showing a net to a user:
 *
 * - wires are joined at their ends and at junctions,
 * - pins, labels and sheet pins join a wire that ends on them, or passes
 *   through them,
 * - local labels and hierarchical labels join by name inside one sheet
 *   instance, global labels and power symbols join by name everywhere,
 * - a sheet pin joins the hierarchical label of the same name inside the
 *   sheet it stands for,
 * - invisible power input pins join the global net of their pin name.
 *
 * Nets are named like KiCad does: the highest priority driver wins (global
 * label, power symbol, local label, hierarchical label, sheet pin, pin) and
 * local names carry the path of the sheet ("/Power/VIN"). A net with no label
 * gets "Net-(R1-Pad1)", or "unconnected-(R1-Pad1)" when it has a single pin.
 * Ties between drivers of the same priority are broken alphabetically, which
 * may differ from KiCad in rare cases. When exact names matter, the names of a
 * netlist exported by `kicad-cli sch export netlist` can be applied with
 * `SchematicNetlist.apply_names()`.
 *
 * Buses are only grouped (and named after their label), the nets that run
 * through bus entries are not tied to the bus.
 */

/** A sheet instance: a schematic document placed at a hierarchical path. */
export interface NetlistSheet {
    /** "/<root uuid>" for the root sheet, then "/<uuid>/<sheet uuid>/...". */
    path: string;
    doc: KicadSch;
}

export type NetLabelItem = NetLabel | GlobalLabel | HierarchicalLabel;

/** Anything that belongs to a net. */
export type NetItem =
    | Wire
    | Bus
    | Junction
    | NetLabelItem
    | SchematicSheetPin
    | PinInstance
    | SchematicSymbol;

export type NetItemKind =
    | "wire"
    | "bus"
    | "junction"
    | "label"
    | "sheet_pin"
    | "pin"
    | "power";

/** A symbol pin on a net. */
export interface NetPin {
    sheet_path: string;
    symbol: SchematicSymbol;
    pin: PinInstance;
    /** Reference of the symbol in this sheet instance, like "R12". */
    reference: string;
    /** Pin number, like "1" or "A3". */
    number: string;
    /** Pin name, "" when it has none. */
    name: string;
}

/** The result of looking for a net at a point of a sheet. */
export interface NetPick {
    kind: Exclude<NetItemKind, "label" | "power">;
    item: Wire | Bus | Junction | PinInstance | SchematicSheetPin;
    net: SchematicNet;
    /** Distance from the point to the item, in mm. */
    distance: number;
}

/** A net of the schematic, across all of its sheets. */
export class SchematicNet {
    /** Items of the net, by sheet instance path. */
    members = new Map<string, NetItem[]>();
    pins: NetPin[] = [];
    /** True when a label or power symbol, not a pin, gave the net its name. */
    named = false;
    /** Where the name comes from. */
    name_source: "label" | "auto" | "netlist" = "auto";
    /** For buses, the nets they carry ("D0", "D1"...), when the label says. */
    bus_members: string[] = [];

    constructor(
        public id: number,
        public name: string,
        public is_bus = false,
    ) {}

    /** Instance paths of the sheets the net is drawn on. */
    get sheet_paths(): string[] {
        return [...this.members.keys()];
    }

    items_on(sheet_path: string): NetItem[] {
        return this.members.get(sheet_path) ?? [];
    }
}

/** A net of an external netlist (see parse_netlist). */
export interface ExternalNet {
    name: string;
    nodes: { ref: string; pin: string }[];
}

// Driver priorities, as in CONNECTION_SUBGRAPH::PRIORITY
enum Priority {
    none,
    pin,
    sheet_pin,
    hier_label,
    local_label,
    power,
    global_label,
}

type Segment = { item: Wire | Bus; a: Vec2; b: Vec2; node: number };
type PinModel = {
    node: number;
    pin: PinInstance;
    symbol: SchematicSymbol;
    a: Vec2;
    b: Vec2;
    hidden: boolean;
    type: string;
    name: string;
    number: string;
    reference: string;
};
type PointEntry = {
    at: Vec2;
    wires: number[];
    buses: number[];
    others: { node: number; kind: NetItemKind }[];
};
type Driver = { priority: Priority; name: string };

/** Node of a sheet in the union-find, with what is needed to name it. */
type NodeInfo = {
    sheet: SheetModel;
    kind: NetItemKind;
    item: NetItem;
    driver?: Driver;
    pin?: PinModel;
};

class SheetModel {
    segments: Segment[] = [];
    pins: PinModel[] = [];
    pin_models = new Map<PinInstance, PinModel>();
    sheet_pins: { node: number; item: SchematicSheetPin; at: Vec2 }[] = [];
    junctions: { node: number; item: Junction; at: Vec2 }[] = [];
    labels: { node: number; item: NetLabelItem; at: Vec2 }[] = [];
    symbols: { node: number; item: SchematicSymbol }[] = [];
    points = new Map<string, PointEntry>();

    constructor(
        public path: string,
        public doc: KicadSch,
        public name_path: string,
    ) {}
}

class UnionFind {
    #parent: number[] = [];

    add(): number {
        this.#parent.push(this.#parent.length);
        return this.#parent.length - 1;
    }

    find(i: number): number {
        let root = i;
        while (this.#parent[root] !== root) {
            root = this.#parent[root]!;
        }
        while (this.#parent[i] !== root) {
            const next = this.#parent[i]!;
            this.#parent[i] = root;
            i = next;
        }
        return root;
    }

    union(a: number, b: number) {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra !== rb) {
            this.#parent[Math.max(ra, rb)] = Math.min(ra, rb);
        }
    }

    union_all(nodes: number[]) {
        for (let i = 1; i < nodes.length; i++) {
            this.union(nodes[0]!, nodes[i]!);
        }
    }
}

const EPSILON = 0.005;

/** True for the name of a bus: "D[0..7]", "USB{DP DM}". */
const is_bus_name = (text: string) => /[{}]|\[\d+\.\.\d+\]/.test(text);

/** KiCad writes a "/" in a net name as "{slash}", it is the sheet separator. */
const net_text = (text: string) => text.replaceAll("/", "{slash}");

function point_key(p: Vec2) {
    return `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;
}

/** Distance from a point to the segment a-b. */
export function distance_to_segment(p: Vec2, a: Vec2, b: Vec2): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** True when p is on the segment a-b, but not at one of its ends. */
function on_segment_interior(p: Vec2, a: Vec2, b: Vec2): boolean {
    if (Math.hypot(p.x - a.x, p.y - a.y) < EPSILON) {
        return false;
    }
    if (Math.hypot(p.x - b.x, p.y - b.y) < EPSILON) {
        return false;
    }
    return distance_to_segment(p, a, b) < EPSILON;
}

function is_power_symbol(symbol: SchematicSymbol): boolean {
    try {
        return !!symbol.lib_symbol?.power;
    } catch {
        return false;
    }
}

/**
 * Where a library pin ends up on the sheet, for a placed symbol: its
 * connection point (the end that wires attach to) and the other end of its
 * stem, at the body. Same transformation as the pin painter.
 */
export function pin_geometry(
    symbol: SchematicSymbol,
    x: number,
    y: number,
    angle: number,
    length: number,
): { a: Vec2; b: Vec2 } {
    const turns = Math.round((((symbol.at.rotation % 360) + 360) % 360) / 90);
    const rad = (angle * Math.PI) / 180;
    const ends = [
        [x, y],
        [x + length * Math.cos(rad), y + length * Math.sin(rad)],
    ].map(([px, py]) => {
        let tx = px!;
        let ty = py!;
        for (let i = 0; i < turns; i++) {
            [tx, ty] = [-ty, tx];
        }
        if (symbol.mirror == "x") {
            ty = -ty;
        } else if (symbol.mirror == "y") {
            tx = -tx;
        }
        return new Vec2(symbol.at.position.x + tx, symbol.at.position.y - ty);
    });
    return { a: ends[0]!, b: ends[1]! };
}

/**
 * Names of the nets a bus label carries: "D[0..3]" is D0 to D3, "{A B}" is A
 * and B, "USB{DP DM}" is USB.DP and USB.DM.
 */
export function expand_bus_name(name: string): string[] {
    const vector = (text: string): string[] | null => {
        const m = /^(.*)\[(\d+)\.\.(\d+)\]$/.exec(text);
        if (!m) {
            return null;
        }
        const lo = Math.min(+m[2]!, +m[3]!);
        const hi = Math.max(+m[2]!, +m[3]!);
        const out: string[] = [];
        for (let i = lo; i <= hi; i++) {
            out.push(`${m[1]}${i}`);
        }
        return out;
    };
    const group = /^([^{}]*)\{(.*)\}$/.exec(name);
    if (group) {
        const prefix = group[1]!;
        const out: string[] = [];
        for (const member of group[2]!.split(/[\s,]+/).filter(Boolean)) {
            for (const n of vector(member) ?? [member]) {
                out.push(prefix ? `${prefix}.${n}` : n);
            }
        }
        return out;
    }
    return vector(name) ?? [];
}

/**
 * Reads the nets of a netlist exported by `kicad-cli sch export netlist`
 * (the default, KiCad s-expression format).
 */
export function parse_netlist(text: string): ExternalNet[] {
    const nets: ExternalNet[] = [];
    const field = (list: List, name: string) => {
        for (const e of list) {
            if (Array.isArray(e) && e[0] === name) {
                return e[1];
            }
        }
        return undefined;
    };
    const walk = (list: List) => {
        for (const e of list) {
            if (!Array.isArray(e)) {
                continue;
            }
            if (e[0] === "net") {
                const name = field(e, "name");
                const net: ExternalNet = {
                    name: String(name ?? ""),
                    nodes: [],
                };
                for (const n of e) {
                    if (Array.isArray(n) && n[0] === "node") {
                        net.nodes.push({
                            ref: String(field(n, "ref") ?? ""),
                            pin: String(field(n, "pin") ?? ""),
                        });
                    }
                }
                if (net.name) {
                    nets.push(net);
                }
            } else {
                walk(e);
            }
        }
    };
    walk(listify(text));
    return nets;
}

/**
 * The connectivity of a set of sheet instances.
 */
export class SchematicNetlist {
    nets: SchematicNet[] = [];
    #sheets = new Map<string, SheetModel>();
    #item_nets = new Map<string, Map<unknown, SchematicNet>>();
    #by_name = new Map<string, SchematicNet>();
    #by_pin = new Map<string, SchematicNet[]>();

    constructor(sheets: NetlistSheet[]) {
        this.#build(sheets);
    }

    /**
     * The connectivity of every schematic of a project.
     *
     * The hierarchy is worked out here, from the sheets that name a file,
     * instead of taken from the project's pages: a project made of files
     * loaded one by one (as the embed does) names them differently from the
     * sheets that use them, and then has no hierarchy.
     */
    static from_project(project: Project): SchematicNetlist {
        const docs = [...project.schematics()];
        const find = (parent: KicadSch, file: string) => {
            const wanted = normalize_join(dirname(parent.filename), file);
            return (
                docs.find((d) => d.filename == wanted) ??
                docs.find((d) => d.filename == file) ??
                docs.find(
                    (d) =>
                        wanted.endsWith(`/${d.filename}`) ||
                        d.filename.endsWith(`/${file}`),
                ) ??
                docs.find((d) => basename(d.filename) == basename(file))
            );
        };

        // for each document, the document of each of its sheets
        const children = new Map<KicadSch, [string, KicadSch][]>();
        const used = new Set<KicadSch>();
        for (const doc of docs) {
            const list: [string, KicadSch][] = [];
            for (const sheet of doc.sheets) {
                const child = sheet.sheetfile
                    ? find(doc, sheet.sheetfile)
                    : undefined;
                if (child && child !== doc) {
                    list.push([sheet.uuid, child]);
                    used.add(child);
                }
            }
            children.set(doc, list);
        }

        const sheets: NetlistSheet[] = [];
        const walk = (doc: KicadSch, path: string, depth: number) => {
            sheets.push({ path, doc });
            if (depth < 16) {
                for (const [uuid, child] of children.get(doc) ?? []) {
                    walk(child, `${path}/${uuid}`, depth + 1);
                }
            }
        };
        // roots are the documents no sheet uses; whatever is left is a cycle
        for (const doc of docs.filter((d) => !used.has(d))) {
            walk(doc, `/${doc.uuid}`, 0);
        }
        for (const doc of docs) {
            if (!sheets.some((s) => s.doc === doc)) {
                walk(doc, `/${doc.uuid}`, 0);
            }
        }
        return new SchematicNetlist(sheets);
    }

    /** Paths of every sheet instance. */
    get sheet_paths(): string[] {
        return [...this.#sheets.keys()];
    }

    /** Paths of the sheet instances that show a document. */
    paths_of(doc: KicadSch): string[] {
        return [...this.#sheets.values()]
            .filter((s) => s.doc === doc)
            .map((s) => s.path);
    }

    /** The net an item of a sheet instance belongs to. */
    net_of(sheet_path: string, item: unknown): SchematicNet | null {
        return this.#item_nets.get(sheet_path)?.get(item) ?? null;
    }

    /** The two ends of a pin's stem on a sheet instance: connection point, body. */
    pin_segment(
        sheet_path: string,
        pin: PinInstance,
    ): { a: Vec2; b: Vec2 } | null {
        const model = this.#sheets.get(sheet_path)?.pin_models.get(pin);
        return model ? { a: model.a, b: model.b } : null;
    }

    net_by_name(name: string): SchematicNet | undefined {
        return this.#by_name.get(name);
    }

    /** The net of a pin, by the reference of its symbol and its number. */
    net_for_pin(reference: string, number: string): SchematicNet | undefined {
        return this.#by_pin.get(`${reference}\0${number}`)?.[0];
    }

    /**
     * The net under a point of a sheet instance: a pin, sheet pin, junction,
     * wire or bus within `tolerance` mm of it. Pins win over junctions, and
     * those over wires. Labels and power symbols are not found here: their
     * size depends on how they are drawn.
     */
    pick(sheet_path: string, p: Vec2, tolerance: number): NetPick | null {
        const sheet = this.#sheets.get(sheet_path);
        if (!sheet) {
            return null;
        }
        const nets = this.#item_nets.get(sheet_path)!;
        const found: { best: (NetPick & { rank: number }) | null } = {
            best: null,
        };
        const consider = (
            rank: number,
            kind: NetPick["kind"],
            item: NetPick["item"],
            distance: number,
        ) => {
            if (distance > tolerance) {
                return;
            }
            const net = nets.get(item);
            if (!net) {
                return;
            }
            const best = found.best;
            if (
                !best ||
                rank < best.rank ||
                (rank == best.rank && distance < best.distance)
            ) {
                found.best = { kind, item, net, distance, rank };
            }
        };
        for (const pin of sheet.pins) {
            if (!pin.hidden) {
                consider(
                    0,
                    "pin",
                    pin.pin,
                    distance_to_segment(p, pin.a, pin.b),
                );
            }
        }
        for (const sp of sheet.sheet_pins) {
            consider(
                0,
                "sheet_pin",
                sp.item,
                Math.hypot(p.x - sp.at.x, p.y - sp.at.y),
            );
        }
        for (const j of sheet.junctions) {
            consider(
                1,
                "junction",
                j.item,
                Math.hypot(p.x - j.at.x, p.y - j.at.y),
            );
        }
        for (const s of sheet.segments) {
            const bus = nets.get(s.item)?.is_bus ?? false;
            consider(
                2,
                bus ? "bus" : "wire",
                s.item,
                distance_to_segment(p, s.a, s.b),
            );
        }
        if (!found.best) {
            return null;
        }
        const { rank: _rank, ...pick } = found.best;
        return pick;
    }

    /**
     * Gives the nets the names of an external netlist (from KiCad itself), for
     * the nets that have pins. Returns how many were renamed.
     */
    apply_names(external: ExternalNet[]): number {
        const by_pin = new Map<string, string>();
        for (const net of external) {
            for (const node of net.nodes) {
                by_pin.set(`${node.ref}\0${node.pin}`, net.name);
            }
        }
        let count = 0;
        for (const net of this.nets) {
            const votes = new Map<string, number>();
            for (const pin of net.pins) {
                const name = by_pin.get(`${pin.reference}\0${pin.number}`);
                if (name) {
                    votes.set(name, (votes.get(name) ?? 0) + 1);
                }
            }
            let best: string | null = null;
            let best_count = 0;
            for (const [name, n] of votes) {
                if (n > best_count) {
                    best = name;
                    best_count = n;
                }
            }
            if (best !== null) {
                net.name_source = "netlist";
                net.named = true;
                if (best != net.name) {
                    net.name = best;
                    count++;
                }
            }
        }
        this.#index_names();
        return count;
    }

    #index_names() {
        this.#by_name.clear();
        for (const net of this.nets) {
            if (!this.#by_name.has(net.name)) {
                this.#by_name.set(net.name, net);
            }
        }
    }

    #build(inputs: NetlistSheet[]) {
        const by_path = new Map(inputs.map((s) => [s.path, s]));
        const name_paths = new Map<string, string>();
        const name_path_of = (path: string): string => {
            const known = name_paths.get(path);
            if (known !== undefined) {
                return known;
            }
            const parts = path.split("/").filter(Boolean);
            let out = "/";
            for (let k = 2; k <= parts.length; k++) {
                const parent = by_path.get(
                    "/" + parts.slice(0, k - 1).join("/"),
                );
                const uuid = parts[k - 1]!;
                const sheet = parent?.doc.sheets.find((s) => s.uuid == uuid);
                out += `${sheet?.sheetname ?? sheet?.sheetfile ?? uuid}/`;
            }
            name_paths.set(path, out);
            return out;
        };

        const uf = new UnionFind();
        const infos: NodeInfo[] = [];
        const new_node = (
            sheet: SheetModel,
            kind: NetItemKind,
            item: NetItem,
            driver?: Driver,
        ) => {
            const node = uf.add();
            infos.push({ sheet, kind, item, driver });
            return node;
        };

        const sheets = inputs.map(
            (s) => new SheetModel(s.path, s.doc, name_path_of(s.path)),
        );
        for (const sheet of sheets) {
            this.#sheets.set(sheet.path, sheet);
        }

        const reference_of = (symbol: SchematicSymbol, path: string) => {
            const key = `${path}/${symbol.uuid}`;
            for (const s of inputs) {
                const legacy = s.doc.symbol_instances?.get(key);
                if (legacy?.reference) {
                    return legacy.reference;
                }
            }
            return symbol.instances.get(path)?.reference ?? symbol.reference;
        };

        // 1. Nodes and the points where they can touch.
        const entry = (sheet: SheetModel, at: Vec2) => {
            const key = point_key(at);
            let e = sheet.points.get(key);
            if (!e) {
                e = { at, wires: [], buses: [], others: [] };
                sheet.points.set(key, e);
            }
            return e;
        };
        // Names that join nodes: per sheet instance (local) and everywhere.
        // every label, by text, to find the nets a bus carries
        const label_texts = new Map<string, { node: number; path: string }[]>();
        const local_names = new Map<string, number[]>();
        const hier_names = new Map<string, number[]>();
        const global_names = new Map<string, number[]>();
        const join = (
            map: Map<string, number[]>,
            key: string,
            node: number,
        ) => {
            const list = map.get(key);
            if (list) {
                list.push(node);
            } else {
                map.set(key, [node]);
            }
        };

        for (const sheet of sheets) {
            const doc = sheet.doc;
            for (const [list, kind] of [
                [doc.wires, "wire"],
                [doc.buses, "bus"],
            ] as const) {
                for (const item of list) {
                    const node = new_node(sheet, kind, item);
                    for (let i = 0; i < item.pts.length; i++) {
                        const p = item.pts[i]!;
                        const e = entry(sheet, p);
                        (kind == "wire" ? e.wires : e.buses).push(node);
                        const q = item.pts[i + 1];
                        if (q) {
                            sheet.segments.push({ item, a: p, b: q, node });
                        }
                    }
                }
            }
            for (const item of doc.junctions) {
                const at = item.at.position;
                const node = new_node(sheet, "junction", item);
                sheet.junctions.push({ node, item, at });
                entry(sheet, at).others.push({ node, kind: "junction" });
            }
            const labels: [NetLabelItem[], Priority][] = [
                [doc.net_labels, Priority.local_label],
                [doc.hierarchical_labels, Priority.hier_label],
                [doc.global_labels, Priority.global_label],
            ];
            for (const [list, priority] of labels) {
                for (const item of list) {
                    const at = item.at.position;
                    const text = net_text(item.shown_text);
                    const name =
                        priority == Priority.global_label
                            ? text
                            : sheet.name_path + text;
                    const node = new_node(sheet, "label", item, {
                        priority,
                        name,
                    });
                    sheet.labels.push({ node, item, at });
                    const same_text = label_texts.get(item.shown_text);
                    if (same_text) {
                        same_text.push({ node, path: sheet.path });
                    } else {
                        label_texts.set(item.shown_text, [
                            { node, path: sheet.path },
                        ]);
                    }
                    entry(sheet, at).others.push({ node, kind: "label" });
                    if (priority == Priority.global_label) {
                        join(global_names, item.shown_text, node);
                    } else {
                        const key = `${sheet.path}\0${item.shown_text}`;
                        join(local_names, key, node);
                        if (priority == Priority.hier_label) {
                            join(hier_names, key, node);
                        }
                    }
                }
            }
            for (const item of doc.sheets) {
                for (const pin of item.pins) {
                    const at = pin.at.position;
                    const node = new_node(sheet, "sheet_pin", pin, {
                        priority: Priority.sheet_pin,
                        name: sheet.name_path + net_text(pin.name),
                    });
                    sheet.sheet_pins.push({ node, item: pin, at });
                    entry(sheet, at).others.push({ node, kind: "sheet_pin" });
                }
            }
            for (const symbol of doc.symbols.values()) {
                const power = is_power_symbol(symbol);
                let power_node: number | null = null;
                if (power) {
                    power_node = new_node(sheet, "power", symbol, {
                        priority: Priority.power,
                        name: net_text(symbol.value),
                    });
                    sheet.symbols.push({ node: power_node, item: symbol });
                    join(global_names, symbol.value, power_node);
                }
                const reference = reference_of(symbol, sheet.path);
                let pins: PinInstance[] = [];
                try {
                    pins = symbol.unit_pins;
                } catch {
                    // a symbol whose library symbol is missing has no pins
                }
                for (const pin of pins) {
                    let def;
                    try {
                        def = pin.definition;
                    } catch {
                        continue;
                    }
                    const { a, b } = pin_geometry(
                        symbol,
                        def.at.position.x,
                        def.at.position.y,
                        def.at.rotation,
                        def.length,
                    );
                    const model: PinModel = {
                        node: new_node(sheet, "pin", pin),
                        pin,
                        symbol,
                        a,
                        b,
                        hidden: def.hide,
                        type: def.type,
                        name: def.name.text,
                        number: def.number.text,
                        reference,
                    };
                    infos[model.node]!.pin = model;
                    sheet.pins.push(model);
                    sheet.pin_models.set(pin, model);
                    entry(sheet, a).others.push({
                        node: model.node,
                        kind: "pin",
                    });
                    if (power_node !== null) {
                        // a power symbol is one with its pin
                        uf.union(power_node, model.node);
                    } else if (def.hide && def.type == "power_in") {
                        // invisible power inputs join the net of their name
                        infos[model.node]!.driver = {
                            priority: Priority.power,
                            name: net_text(def.name.text),
                        };
                        join(global_names, def.name.text, model.node);
                    }
                }
            }
        }

        // 2. Geometry: what touches what inside each sheet instance.
        for (const sheet of sheets) {
            for (const e of sheet.points.values()) {
                uf.union_all(e.wires);
                uf.union_all(e.buses);
                if (!e.others.length) {
                    continue;
                }
                const through = (buses: boolean) =>
                    sheet.segments
                        .filter(
                            (s) =>
                                (infos[s.node]!.kind == "bus") == buses &&
                                on_segment_interior(e.at, s.a, s.b),
                        )
                        .map((s) => s.node);
                const junction = e.others.some((o) => o.kind == "junction");
                const wires = [...e.wires, ...through(false)];
                const buses = [...e.buses, ...through(true)];
                const nodes = e.others.map((o) => o.node);
                if (junction) {
                    uf.union_all(wires);
                    uf.union_all(buses);
                    uf.union_all([...nodes, ...wires]);
                } else if (wires.length) {
                    uf.union_all([...nodes, ...wires]);
                } else if (buses.length) {
                    // labels and the sheet pins of buses sit on buses, pins never do
                    const labels = e.others
                        .filter(
                            (o) =>
                                o.kind == "label" ||
                                (o.kind == "sheet_pin" &&
                                    is_bus_name(
                                        (infos[o.node]!.item as SchematicSheetPin)
                                            .name,
                                    )),
                        )
                        .map((o) => o.node);
                    uf.union_all([...labels, ...buses]);
                    uf.union_all(nodes.filter((n) => !labels.includes(n)));
                } else {
                    uf.union_all(nodes);
                }
            }
        }

        // 3. Names: inside a sheet instance, and across the hierarchy.
        for (const nodes of local_names.values()) {
            uf.union_all(nodes);
        }
        for (const nodes of global_names.values()) {
            uf.union_all(nodes);
        }
        for (const sheet of sheets) {
            for (const parent_sheet of sheet.doc.sheets) {
                const child = this.#sheets.get(
                    `${sheet.path}/${parent_sheet.uuid}`,
                );
                if (!child) {
                    continue;
                }
                for (const sp of sheet.sheet_pins) {
                    if (!parent_sheet.pins.includes(sp.item)) {
                        continue;
                    }
                    const labels = hier_names.get(
                        `${child.path}\0${sp.item.name}`,
                    );
                    if (labels) {
                        uf.union_all([sp.node, ...labels]);
                    }
                }
            }
        }

        // A bus carries nets named after its members ("D0", "USB.DP"): in every
        // sheet the bus reaches, the labels of a member are the same net.
        const bus_sheets = new Map<number, Set<string>>();
        const bus_members = new Map<number, Set<string>>();
        for (let i = 0; i < infos.length; i++) {
            if (infos[i]!.kind == "bus") {
                const root = uf.find(i);
                if (!bus_sheets.has(root)) {
                    bus_sheets.set(root, new Set());
                    bus_members.set(root, new Set());
                }
            }
        }
        for (let i = 0; i < infos.length; i++) {
            const info = infos[i]!;
            const root = uf.find(i);
            const sheets_of = bus_sheets.get(root);
            if (!sheets_of) {
                continue;
            }
            sheets_of.add(info.sheet.path);
            const item = info.item;
            const text =
                info.kind == "label"
                    ? (item as NetLabelItem).shown_text
                    : info.kind == "sheet_pin"
                      ? (item as SchematicSheetPin).name
                      : "";
            for (const member of expand_bus_name(text)) {
                bus_members.get(root)!.add(member);
            }
        }
        for (const [root, members] of bus_members) {
            for (const member of members) {
                const nodes = (label_texts.get(member) ?? [])
                    .filter((l) => bus_sheets.get(root)!.has(l.path))
                    .map((l) => l.node);
                uf.union_all(nodes);
            }
        }

        // 4. Gather the nets and name them.
        const roots = new Map<number, number[]>();
        for (let i = 0; i < infos.length; i++) {
            const root = uf.find(i);
            const list = roots.get(root);
            if (list) {
                list.push(i);
            } else {
                roots.set(root, [i]);
            }
        }
        for (const nodes of roots.values()) {
            this.#add_net(nodes, infos);
        }
        this.#index_names();
    }

    #add_net(nodes: number[], infos: NodeInfo[]) {
        const is_bus = nodes.some((n) => infos[n]!.kind == "bus");
        const net = new SchematicNet(this.nets.length, "", is_bus);
        let best: Driver | null = null;
        const pins: { text: string; pin: NetPin; named: boolean }[] = [];
        for (const n of nodes) {
            const info = infos[n]!;
            const path = info.sheet.path;
            let members = net.members.get(path);
            if (!members) {
                members = [];
                net.members.set(path, members);
            }
            members.push(info.item);
            let items = this.#item_nets.get(path);
            if (!items) {
                items = new Map();
                this.#item_nets.set(path, items);
            }
            items.set(info.item, net);
            const d = info.driver;
            if (
                d &&
                d.name &&
                (!best ||
                    d.priority > best.priority ||
                    (d.priority == best.priority && d.name < best.name))
            ) {
                best = d;
            }
            if (info.kind == "pin" && info.pin) {
                const m = info.pin;
                if (!is_power_symbol(m.symbol)) {
                    const name = m.name == "~" ? "" : m.name;
                    pins.push({
                        named: name != "",
                        text: `${m.reference}-${net_text(name) || `Pad${m.number}`}`,
                        pin: {
                            sheet_path: path,
                            symbol: m.symbol,
                            pin: m.pin,
                            reference: m.reference,
                            number: m.number,
                            name: name,
                        },
                    });
                }
            }
        }
        net.pins = pins.map((p) => p.pin);
        if (best) {
            net.name = best.name;
            net.named = true;
            net.name_source = "label";
        } else if (pins.length) {
            // KiCad drives with a pin that has a name before one that has not
            const named = pins.filter((p) => p.named);
            const first = (named.length ? named : pins)
                .map((p) => p.text)
                .sort()[0]!;
            net.name =
                pins.length == 1 ? `unconnected-(${first})` : `Net-(${first})`;
        } else {
            net.name = `Net-${net.id}`;
        }
        if (is_bus) {
            net.bus_members = expand_bus_name(net.name.split("/").pop() ?? "");
        }
        for (const p of pins) {
            const key = `${p.pin.reference}\0${p.pin.number}`;
            const list = this.#by_pin.get(key);
            if (list) {
                list.push(net);
            } else {
                this.#by_pin.set(key, [net]);
            }
        }
        this.nets.push(net);
    }
}

const cache = new WeakMap<
    object,
    { docs: KicadSch[]; netlist: SchematicNetlist }
>();

/**
 * The connectivity for a schematic document: of its whole project when it
 * has one, so that nets run through the hierarchy, else of the document alone.
 * It is built once and reused until the project's schematics change.
 */
export function netlist_for(doc: KicadSch): SchematicNetlist {
    const project = doc.project;
    const key: object = project ?? doc;
    const docs = project ? [...project.schematics()] : [doc];
    const hit = cache.get(key);
    if (
        hit &&
        hit.docs.length == docs.length &&
        hit.docs.every((d, i) => d === docs[i])
    ) {
        return hit.netlist;
    }
    const netlist = project
        ? SchematicNetlist.from_project(project)
        : new SchematicNetlist([{ path: `/${doc.uuid}`, doc }]);
    cache.set(key, { docs, netlist });
    return netlist;
}
