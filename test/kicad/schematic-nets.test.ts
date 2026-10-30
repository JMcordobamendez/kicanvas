/*
    Copyright (c) 2026 José Miguel Córdoba Méndez.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { assert } from "chai";
import { Vec2 } from "../../src/base/math";
import {
    SchematicNetlist,
    distance_to_segment,
    expand_bus_name,
    parse_netlist,
    type NetlistSheet,
} from "../../src/kicad/schematic-nets";
import {
    ROOT,
    SUB,
    bus,
    global_label,
    gnd,
    hier_label,
    junction,
    label,
    resistor,
    schematic,
    sheet_block,
    single,
    symbol,
    wire,
} from "../sch/builders";

suite("kicad.schematic-nets: schematic connectivity", function () {
    test("pins joined by a wire share a net, named after the first pin", function () {
        const { netlist } = single(
            resistor("R1", 100, 100),
            resistor("R2", 100, 113.81),
            wire(100, 103.81, 100, 110),
        );

        const a = netlist.net_for_pin("R1", "2")!;
        const b = netlist.net_for_pin("R2", "1")!;
        assert.isDefined(a);
        assert.strictEqual(a, b);
        assert.equal(a.name, "Net-(R1-Pad2)");
        assert.equal(a.pins.length, 2);
        assert.isFalse(a.named);

        // a pin with nothing on it is a net of its own
        const alone = netlist.net_for_pin("R1", "1")!;
        assert.notStrictEqual(alone, a);
        assert.equal(alone.name, "unconnected-(R1-Pad1)");
    });

    test("wires join at their ends and through a junction, not by crossing", function () {
        // a vertical wire with a horizontal one ending on its middle
        const wires = [wire(100, 100, 100, 120), wire(100, 110, 110, 110)];
        const without = single(...wires);
        const doc = without.doc;
        const w0 = doc.wires[0]!;
        const w1 = doc.wires[1]!;
        const path = `/${ROOT}`;
        assert.notStrictEqual(
            without.netlist.net_of(path, w0),
            without.netlist.net_of(path, w1),
        );

        const joined = single(...wires, junction(100, 110));
        assert.strictEqual(
            joined.netlist.net_of(path, joined.doc.wires[0]!),
            joined.netlist.net_of(path, joined.doc.wires[1]!),
        );

        // end to end
        const chain = single(wire(0, 0, 10, 0), wire(10, 0, 10, 10));
        assert.strictEqual(
            chain.netlist.net_of(path, chain.doc.wires[0]!),
            chain.netlist.net_of(path, chain.doc.wires[1]!),
        );
    });

    test("a pin or label on the middle of a wire joins it", function () {
        const { doc, netlist } = single(
            wire(90, 105, 110, 105),
            // pin 2 of R1 is at (100, 105), in the middle of the wire
            resistor("R1", 100, 101.19),
            label("SIG", 105, 105),
        );
        const net = netlist.net_for_pin("R1", "2")!;
        assert.equal(net.name, "/SIG");
        assert.isTrue(net.named);
        assert.strictEqual(netlist.net_of(`/${ROOT}`, doc.net_labels[0]!), net);
    });

    test("local labels join by name in a sheet, power symbols and global labels everywhere", function () {
        const { netlist } = single(
            // two separate wires, same local label
            wire(10, 10, 20, 10),
            label("A", 10, 10),
            wire(10, 30, 20, 30),
            label("A", 10, 30),
            // and one with another name
            wire(10, 50, 20, 50),
            label("B", 10, 50),
        );
        const names = netlist.nets.map((n) => n.name).sort();
        assert.deepEqual(names, ["/A", "/B"]);

        const two = single(
            wire(10, 10, 20, 10),
            global_label("CLK", 10, 10),
            wire(10, 30, 20, 30),
            global_label("CLK", 10, 30),
            wire(10, 50, 20, 50),
            gnd(10, 50),
            wire(10, 70, 20, 70),
            gnd(20, 70),
        );
        assert.deepEqual(two.netlist.nets.map((n) => n.name).sort(), [
            "CLK",
            "GND",
        ]);
    });

    test("a power symbol names the net of the pins on it, and wins over a local label", function () {
        const { doc, netlist } = single(
            resistor("R1", 100, 100),
            wire(100, 103.81, 100, 110),
            gnd(100, 110),
            label("MINUS", 100, 108),
        );
        const net = netlist.net_for_pin("R1", "2")!;
        assert.equal(net.name, "GND");
        // the power symbol belongs to the net, so it can be picked
        const power = [...doc.symbols.values()].find(
            (s) => s.reference == "#PWR01",
        )!;
        assert.strictEqual(netlist.net_of(`/${ROOT}`, power), net);
        // and it is not counted as a pin of the net
        assert.equal(net.pins.length, 1);
    });

    test("invisible power input pins join the net of their name", function () {
        const { netlist } = single(
            symbol("Test:IC", "U1", "IC", 50, 50, 0, "", ["1", "2"]),
            symbol("Test:IC", "U2", "IC", 100, 50, 0, "", ["1", "2"]),
        );
        const a = netlist.net_for_pin("U1", "1")!;
        const b = netlist.net_for_pin("U2", "1")!;
        assert.strictEqual(a, b);
        assert.equal(a.name, "VDD");
        assert.notStrictEqual(netlist.net_for_pin("U1", "2"), a);
    });

    test("rotation and mirroring move the pins like the symbol painter does", function () {
        const { netlist, doc } = single(
            resistor("R1", 100, 100, 90),
            resistor("R2", 200, 100, 0, "(mirror x)"),
            resistor("R3", 300, 100, 0, "(mirror y)"),
            resistor("R4", 400, 100, 270),
        );
        const segment = (ref: string, n: string) => {
            const s = [...doc.symbols.values()].find(
                (x) => x.reference == ref,
            )!;
            const pin = s.pins.find((p) => p.number == n)!;
            return netlist.pin_segment(`/${ROOT}`, pin)!;
        };
        const near = (v: Vec2, x: number, y: number) =>
            assert.isBelow(
                Math.hypot(v.x - x, v.y - y),
                1e-6,
                `${v.x},${v.y} vs ${x},${y}`,
            );

        near(segment("R1", "1").a, 96.19, 100);
        near(segment("R1", "2").a, 103.81, 100);
        near(segment("R2", "1").a, 200, 103.81);
        near(segment("R3", "1").a, 300, 96.19);
        near(segment("R4", "1").a, 403.81, 100);
        // the stem goes from the connection point towards the body
        near(segment("R1", "1").b, 97.46, 100);
    });

    test("hierarchy: a sheet pin joins the hierarchical label of its sheet", function () {
        const root = schematic(
            ROOT,
            resistor("R1", 100, 100),
            wire(100, 103.81, 100, 110),
            wire(100, 110, 150, 110),
            sheet_block("Sub", "sub.kicad_sch", SUB, 150, 100, [
                ["IN", 150, 110],
            ]),
        );
        const sub = schematic(
            "33333333-3333-4333-8333-333333333333",
            hier_label("IN", 20, 20),
            wire(20, 20, 30, 20),
            // pin 1 of R2 is at (30, 20)
            resistor("R2", 30, 23.81, 0),
        );
        const sheets: NetlistSheet[] = [
            { path: `/${ROOT}`, doc: root },
            { path: `/${ROOT}/${SUB}`, doc: sub },
        ];
        const netlist = new SchematicNetlist(sheets);

        const a = netlist.net_for_pin("R1", "2")!;
        const b = netlist.net_for_pin("R2", "1")!;
        assert.isDefined(a);
        assert.strictEqual(a, b);
        assert.equal(a.name, "/Sub/IN");
        assert.deepEqual(
            a.sheet_paths.sort(),
            sheets.map((s) => s.path).sort(),
        );
        assert.isAbove(a.items_on(`/${ROOT}/${SUB}`).length, 0);
    });

    test("the same sheet used twice makes two sets of local nets", function () {
        const root = schematic(
            ROOT,
            sheet_block("A", "sub.kicad_sch", SUB, 50, 50, []),
            sheet_block(
                "B",
                "sub.kicad_sch",
                "44444444-4444-4444-8444-444444444444",
                100,
                50,
                [],
            ),
        );
        const sub = schematic(
            "33333333-3333-4333-8333-333333333333",
            wire(10, 10, 20, 10),
            label("X", 10, 10),
        );
        const netlist = new SchematicNetlist([
            { path: `/${ROOT}`, doc: root },
            { path: `/${ROOT}/${SUB}`, doc: sub },
            { path: `/${ROOT}/44444444-4444-4444-8444-444444444444`, doc: sub },
        ]);
        const names = netlist.nets.map((n) => n.name).sort();
        assert.deepEqual(names, ["/A/X", "/B/X"]);
        assert.deepEqual(
            netlist.paths_of(sub).sort(),
            [
                `/${ROOT}/${SUB}`,
                `/${ROOT}/44444444-4444-4444-8444-444444444444`,
            ].sort(),
        );
        const wire_item = sub.wires[0]!;
        assert.notStrictEqual(
            netlist.net_of(`/${ROOT}/${SUB}`, wire_item),
            netlist.net_of(
                `/${ROOT}/44444444-4444-4444-8444-444444444444`,
                wire_item,
            ),
        );
    });

    test("pick() finds pins, junctions and wires near a point", function () {
        const { doc, netlist } = single(
            resistor("R1", 100, 100),
            wire(100, 103.81, 100, 120),
            wire(100, 120, 130, 120),
            junction(100, 120),
        );
        const path = `/${ROOT}`;

        // on the stem of pin 2
        const pin = netlist.pick(path, new Vec2(100, 102.9), 0.5)!;
        assert.equal(pin.kind, "pin");
        assert.equal(pin.net.name, "unconnected-(R1-Pad2)");

        // on the wire
        const wire_hit = netlist.pick(path, new Vec2(115, 120.2), 0.5)!;
        assert.equal(wire_hit.kind, "wire");
        assert.strictEqual(wire_hit.item, doc.wires[1]);
        assert.strictEqual(wire_hit.net, pin.net);

        // the junction wins over the wires that meet there
        assert.equal(
            netlist.pick(path, new Vec2(100, 120), 0.5)!.kind,
            "junction",
        );

        // nothing there
        assert.isNull(netlist.pick(path, new Vec2(50, 50), 0.5));
        assert.isNull(netlist.pick("/nowhere", new Vec2(100, 110), 0.5));
    });

    test("buses are grouped apart from wires and named after their label", function () {
        const { doc, netlist } = single(
            bus(10, 10, 40, 10),
            label("D[0..3]", 20, 10),
            wire(10, 10, 10, 20),
        );
        const path = `/${ROOT}`;
        const b = netlist.net_of(path, doc.buses[0]!)!;
        assert.isTrue(b.is_bus);
        assert.equal(b.name, "/D[0..3]");
        assert.deepEqual(b.bus_members, ["D0", "D1", "D2", "D3"]);
        // a wire ending on the bus is not on it
        assert.notStrictEqual(netlist.net_of(path, doc.wires[0]!), b);
        assert.equal(netlist.pick(path, new Vec2(30, 10.1), 0.5)!.kind, "bus");
    });

    test("names can be replaced by those of a KiCad netlist", function () {
        const { netlist } = single(
            resistor("R1", 100, 100),
            resistor("R2", 100, 113.81),
            wire(100, 103.81, 100, 110),
        );
        const external = parse_netlist(`(export (version "E")
            (nets
                (net (code "1") (name "/VOUT") (class "Default")
                    (node (ref "R1") (pin "2") (pintype "passive"))
                    (node (ref "R2") (pin "1") (pintype "passive")))
                (net (code "2") (name "unconnected-(R2-Pad2)")
                    (node (ref "R2") (pin "2") (pintype "passive")))))`);
        assert.equal(external.length, 2);
        assert.deepEqual(external[0]!.nodes, [
            { ref: "R1", pin: "2" },
            { ref: "R2", pin: "1" },
        ]);

        const renamed = netlist.apply_names(external);
        assert.equal(renamed, 1);
        assert.equal(netlist.net_for_pin("R1", "2")!.name, "/VOUT");
        assert.strictEqual(
            netlist.net_by_name("/VOUT"),
            netlist.net_for_pin("R2", "1"),
        );
        assert.equal(netlist.net_for_pin("R1", "2")!.name_source, "netlist");
    });
});

suite("kicad.schematic-nets: helpers", function () {
    test("expand_bus_name()", function () {
        assert.deepEqual(expand_bus_name("D[0..2]"), ["D0", "D1", "D2"]);
        assert.deepEqual(expand_bus_name("A[3..1]"), ["A1", "A2", "A3"]);
        assert.deepEqual(expand_bus_name("{A B}"), ["A", "B"]);
        assert.deepEqual(expand_bus_name("USB{DP DM}"), ["USB.DP", "USB.DM"]);
        assert.deepEqual(expand_bus_name("SIGNAL"), []);
    });

    test("distance_to_segment()", function () {
        const a = new Vec2(0, 0);
        const b = new Vec2(10, 0);
        assert.equal(distance_to_segment(new Vec2(5, 3), a, b), 3);
        assert.equal(distance_to_segment(new Vec2(-4, 3), a, b), 5);
        assert.equal(distance_to_segment(new Vec2(13, 4), a, b), 5);
        assert.equal(distance_to_segment(new Vec2(1, 1), a, a), Math.SQRT2);
    });
});
