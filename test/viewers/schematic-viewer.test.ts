/*
    Copyright (c) 2026 José Miguel Córdoba Méndez.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { assert } from "chai";
import { Vec2 } from "../../src/base/math";
import { SchematicSymbol } from "../../src/kicad/schematic";
import kicad_default from "../../src/kicanvas/themes/kicad-default";
import { KiCanvasNetHighlightEvent } from "../../src/viewers/base/events";
import { LayerNames } from "../../src/viewers/schematic/layers";
import {
    label_bbox,
    power_symbol_bbox,
} from "../../src/viewers/schematic/net-painter";
import { SchematicViewer } from "../../src/viewers/schematic/viewer";
import { gnd, label, resistor, schematic, wire, ROOT } from "../sch/builders";

suite("viewers.schematic.SchematicViewer: nets", function () {
    let canvas: HTMLCanvasElement;
    let viewer: SchematicViewer;

    const doc = schematic(
        ROOT,
        resistor("R1", 100, 100),
        wire(100, 103.81, 100, 120),
        label("SIG", 100, 112),
        gnd(100, 120),
        // another net, with nothing on it but a wire
        wire(150, 100, 180, 100),
    );
    const path = `/${ROOT}`;

    setup(async function () {
        canvas = document.createElement("canvas");
        canvas.style.cssText =
            "position:fixed;left:0;top:0;width:800px;height:600px";
        document.body.appendChild(canvas);
        viewer = new SchematicViewer(canvas, true, kicad_default.schematic);
        await viewer.setup();
        await viewer.load(doc);
        await viewer.loaded;
    });

    teardown(async function () {
        // let the frame the viewer has queued draw before it is disposed
        await new Promise((resolve) => setTimeout(resolve, 100));
        viewer.dispose();
        canvas.remove();
    });

    // a click at a point of the sheet, in sheet coordinates
    function click(p: Vec2) {
        const s = viewer.viewport.camera.world_to_screen(p);
        const r = canvas.getBoundingClientRect();
        const init = { clientX: r.left + s.x, clientY: r.top + s.y };
        canvas.dispatchEvent(new MouseEvent("mousemove", init));
        canvas.dispatchEvent(new MouseEvent("click", init));
    }

    const highlight_layer = () =>
        viewer.layers.by_name(LayerNames.net_highlight)!;

    test("a click on a wire selects it and highlights its net", function () {
        click(new Vec2(100, 106));

        assert.strictEqual(viewer.selected?.context, doc.wires[0]);
        const net = viewer.highlighted_net!;
        assert.isNotNull(net);
        assert.strictEqual(viewer.net_of(doc.wires[0]), net);
        assert.equal(net.name, "GND");
        assert.isTrue(highlight_layer().highlighted);
        assert.isDefined(highlight_layer().graphics);
    });

    test("a click on a label selects it", function () {
        const l = doc.net_labels[0]!;
        click(label_bbox(l).center);

        assert.strictEqual(viewer.selected?.context, l);
        assert.strictEqual(viewer.highlighted_net, viewer.net_of(l));
    });

    test("a click on a pin selects the pin and its net", function () {
        click(new Vec2(100, 103));

        const pin = [...doc.symbols.values()]
            .find((s) => s.reference == "R1")!
            .pins.find((p) => p.number == "2");
        assert.strictEqual(viewer.selected?.context, pin);
        assert.strictEqual(viewer.highlighted_net, viewer.net_of(pin));
    });

    test("a click on a power symbol selects it", function () {
        const power = [...doc.symbols.values()].find(
            (s) => s.reference == "#PWR01",
        )!;
        click(power_symbol_bbox(kicad_default.schematic, power).center);

        assert.strictEqual(viewer.selected?.context, power);
        assert.strictEqual(viewer.highlighted_net, viewer.net_of(power));
    });

    test("a click on a symbol body still selects the symbol, without a net", function () {
        click(new Vec2(100, 100));

        const ctx = viewer.selected?.context;
        assert.instanceOf(ctx, SchematicSymbol);
        assert.equal((ctx as SchematicSymbol).reference, "R1");
        assert.isNull(viewer.highlighted_net);
        assert.isFalse(highlight_layer().highlighted);
    });

    test("a click on nothing clears the selection and the net", function () {
        click(new Vec2(100, 106));
        assert.isNotNull(viewer.highlighted_net);

        click(new Vec2(250, 180));

        assert.isNull(viewer.selected);
        assert.isNull(viewer.highlighted_net);
        assert.isFalse(highlight_layer().highlighted);
    });

    test("highlight_net() takes a net or its name, and null clears", function () {
        const events: unknown[] = [];
        viewer.addEventListener(KiCanvasNetHighlightEvent.type, (e) => {
            events.push(e.detail.net);
        });

        viewer.highlight_net("GND");
        assert.equal(viewer.highlighted_net?.name, "GND");
        assert.isTrue(highlight_layer().highlighted);

        viewer.highlight_net(viewer.netlist.net_of(path, doc.wires[1]));
        assert.match(viewer.highlighted_net!.name, /^Net-\d+$/);
        assert.isTrue(highlight_layer().highlighted);

        viewer.highlight_net("no such net");
        assert.isNull(viewer.highlighted_net);

        viewer.highlight_net(null);
        assert.isFalse(highlight_layer().highlighted);
        assert.equal(events.length, 4);
    });

    test("the highlight survives painting again, as when the sheet changes", function () {
        viewer.highlight_net("GND");
        viewer.paint();
        assert.equal(viewer.highlighted_net?.name, "GND");
        assert.isTrue(highlight_layer().highlighted);
        assert.isDefined(highlight_layer().graphics);
    });

    test("select() takes wires, labels and pins", function () {
        viewer.select(doc.wires[0]!);
        assert.strictEqual(viewer.selected?.context, doc.wires[0]);

        viewer.select(doc.net_labels[0]!);
        assert.strictEqual(viewer.selected?.context, doc.net_labels[0]);

        viewer.select(null);
        assert.isNull(viewer.selected);
    });
});
