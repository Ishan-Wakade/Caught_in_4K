using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor.SceneManagement;
using UnityEngine;
using Random = System.Random;

namespace Recyclone
{
    /// <summary>
    /// Builds a randomized room (corner security camera, one trash + one recycling bin, people, items)
    /// from a seed, steps physics by hand, and writes clean PNG frames plus ground truth.
    /// Camera effects (noise, blur, compression) are added later in Python so conditions match the
    /// 2D generator. Usage:
    ///   Unity -batchmode -quit -projectPath sim/unity-mac -executeMethod Recyclone.SimRunner.Render
    ///         -seedStart 1000 -seedEnd 1009 -split dev -out Output -photos ~/photos
    /// </summary>
    public static class SimRunner
    {
        const int Fps = 30, PhysicsPerFrame = 4, W = 1280, H = 720;
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        public static void Render()
        {
            var a = Args();
            int s0 = int.Parse(a.GetValueOrDefault("seedStart", "0")), s1 = int.Parse(a.GetValueOrDefault("seedEnd", "0"));
            string split = a.GetValueOrDefault("split", "dev"), outRoot = a.GetValueOrDefault("out", "Output");
            string photos = a.GetValueOrDefault("photos", "");
            Physics.simulationMode = SimulationMode.Script;
            for (int seed = s0; seed <= s1; seed++)
            {
                var dir = Path.Combine(outRoot, split, $"sim_{split}_{seed:D4}");
                Directory.CreateDirectory(Path.Combine(dir, "frames"));
                new Clip(seed, split, dir, photos).Run();
                Debug.Log($"SIM_CLIP_OK {dir}");
            }
        }

        static Dictionary<string, string> Args()
        {
            var args = Environment.GetCommandLineArgs();
            var d = new Dictionary<string, string>();
            for (int i = 0; i < args.Length - 1; i++)
                if (args[i].StartsWith("-") && !args[i + 1].StartsWith("-")) d[args[i].TrimStart('-')] = args[i + 1];
            return d;
        }

        // ------------------------------------------------------------------------------------------

        class Item
        {
            public string Kind, CatalogId; public GameObject Go; public Rigidbody Rb;
            public int ThrowIndex; public string Scenario; public string IntendedBin;
            public float InsideSince = -1; public string LabeledBin; public float LabeledAt = -1; public float ReleaseAt = -1;
        }

        class Throw
        {
            public string Scenario; public Item Item; public float Start; public string Target;
            public Vector3 From, Release; public float ReleaseAt, EndAt; public GameObject Person;
            public bool Released; public bool CarryAway;
        }

        class Bin { public string Id, Type; public Vector3 Center; public float Half, Height; }

        class Clip
        {
            readonly Random rng; readonly int seed; readonly string split, dir, photos;
            readonly List<Bin> bins = new(); readonly List<Item> items = new(); readonly List<Throw> throws = new();
            readonly Dictionary<string, object> config = new();
            Camera cam; float roomW, roomD, roomH; float duration;
            readonly List<(GameObject go, Vector3 a, Vector3 b, float t0, float t1)> walkers = new();

            public Clip(int seed, string split, string dir, string photos)
            { this.seed = seed; this.split = split; this.dir = dir; this.photos = photos; rng = new Random(seed); }

            float R(float lo, float hi) => (float)(lo + rng.NextDouble() * (hi - lo));
            T Pick<T>(IList<T> xs) => xs[rng.Next(xs.Count)];

            public void Run()
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene);
                Physics.gravity = new Vector3(0, -9.81f, 0);
                BuildRoom(); BuildBins(); BuildCamera(); PlanThrows(); Simulate(); WriteOutputs();
            }

            // ---------------- scene ----------------

            Material Mat(Color c, float smooth = 0.2f, bool transparent = false)
            {
                var m = new Material(Shader.Find("Standard")) { color = c };
                m.SetFloat("_Glossiness", smooth);
                if (transparent)
                {
                    m.SetFloat("_Mode", 3); m.SetInt("_SrcBlend", (int)UnityEngine.Rendering.BlendMode.One);
                    m.SetInt("_DstBlend", (int)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha); m.SetInt("_ZWrite", 0);
                    m.EnableKeyword("_ALPHAPREMULTIPLY_ON"); m.renderQueue = 3000;
                }
                return m;
            }

            Color RandColor(float sMin, float sMax, float vMin, float vMax) => Color.HSVToRGB(R(0, 1), R(sMin, sMax), R(vMin, vMax));

            GameObject Box(string name, Vector3 pos, Vector3 size, Material m, bool collider = true)
            {
                var g = GameObject.CreatePrimitive(PrimitiveType.Cube);
                g.name = name; g.transform.position = pos; g.transform.localScale = size;
                g.GetComponent<Renderer>().sharedMaterial = m;
                if (!collider) UnityEngine.Object.DestroyImmediate(g.GetComponent<Collider>());
                return g;
            }

            void BuildRoom()
            {
                roomW = R(4, 8); roomD = R(4, 7); roomH = R(2.6f, 3.2f);
                var floor = Mat(RandColor(0, 0.3f, 0.35f, 0.8f), R(0.1f, 0.6f));
                var wall = Mat(RandColor(0, 0.25f, 0.6f, 0.95f), 0.1f);
                Box("floor", new Vector3(0, -0.05f, 0), new Vector3(roomW, 0.1f, roomD), floor);
                Box("ceiling", new Vector3(0, roomH + 0.05f, 0), new Vector3(roomW, 0.1f, roomD), Mat(Color.white * 0.9f));
                Box("wall_n", new Vector3(0, roomH / 2, roomD / 2), new Vector3(roomW, roomH, 0.1f), wall);
                Box("wall_s", new Vector3(0, roomH / 2, -roomD / 2), new Vector3(roomW, roomH, 0.1f), wall);
                Box("wall_e", new Vector3(roomW / 2, roomH / 2, 0), new Vector3(0.1f, roomH, roomD), wall);
                Box("wall_w", new Vector3(-roomW / 2, roomH / 2, 0), new Vector3(0.1f, roomH, roomD), wall);
                // clutter: table, chairs, poster
                var wood = Mat(RandColor(0.3f, 0.6f, 0.3f, 0.6f), 0.3f);
                var tx = R(-roomW / 2 + 1, roomW / 2 - 1);
                Box("table", new Vector3(tx, 0.74f, -roomD / 4), new Vector3(R(0.8f, 1.6f), 0.05f, R(0.6f, 1f)), wood);
                for (int i = 0; i < rng.Next(1, 5); i++)
                    Box($"chair_{i}", new Vector3(tx + R(-1, 1), 0.45f, -roomD / 4 + R(-1, 1)), new Vector3(0.45f, 0.9f, 0.45f), Mat(RandColor(0, 0.8f, 0.2f, 0.9f)), false);
                Box("poster", new Vector3(R(-roomW / 3, roomW / 3), R(1.4f, 2f), roomD / 2 - 0.06f), new Vector3(R(0.4f, 1f), R(0.5f, 0.9f), 0.01f), Mat(RandColor(0.4f, 1, 0.4f, 1)), false);

                // lighting: ceiling lights, optional window daylight, sometimes dim
                var mood = Pick(new[] { "bright", "bright", "warm", "dim", "daylight" });
                config["lighting"] = mood;
                RenderSettings.ambientLight = mood == "dim" ? new Color(0.12f, 0.12f, 0.14f) : new Color(0.35f, 0.35f, 0.38f);
                int n = rng.Next(1, 5);
                for (int i = 0; i < n; i++)
                {
                    var l = new GameObject($"light_{i}").AddComponent<Light>();
                    l.type = LightType.Point; l.range = 8; l.shadows = LightShadows.Soft;
                    l.intensity = mood == "dim" ? R(0.3f, 0.6f) : R(0.9f, 1.6f);
                    l.color = mood == "warm" ? new Color(1f, 0.85f, 0.7f) : new Color(1f, 0.98f, 0.95f);
                    l.transform.position = new Vector3(R(-roomW / 3, roomW / 3), roomH - 0.1f, R(-roomD / 3, roomD / 3));
                }
                if (mood == "daylight")
                {
                    var sun = new GameObject("sun").AddComponent<Light>();
                    sun.type = LightType.Directional; sun.intensity = R(0.6f, 1.2f); sun.shadows = LightShadows.Hard;
                    sun.transform.rotation = Quaternion.Euler(R(25, 60), R(0, 360), 0);
                }
            }

            void BuildBins()
            {
                // two bins side by side against the north wall, randomized size/gap/position
                float gap = R(0.3f, 1.5f), half = R(0.2f, 0.3f), h = R(0.6f, 1.0f);
                float cx = R(-roomW / 2 + 1.2f, roomW / 2 - 1.2f - gap), z = roomD / 2 - half - R(0.05f, 0.4f);
                var order = rng.NextDouble() < 0.5 ? new[] { "trash", "recycling" } : new[] { "recycling", "trash" };
                for (int i = 0; i < 2; i++)
                {
                    var type = order[i];
                    var c = new Vector3(cx + i * (2 * half + gap), 0, z);
                    var m = Mat(type == "trash" ? new Color(0.18f, 0.18f, 0.2f) * R(0.8f, 1.4f) : new Color(0.1f, 0.35f, 0.75f) * R(0.8f, 1.2f), 0.35f);
                    float t = 0.02f;
                    Box($"{type}_bottom", c + new Vector3(0, t / 2, 0), new Vector3(2 * half, t, 2 * half), m);
                    Box($"{type}_n", c + new Vector3(0, h / 2, half), new Vector3(2 * half, h, t), m);
                    Box($"{type}_s", c + new Vector3(0, h / 2, -half), new Vector3(2 * half, h, t), m);
                    Box($"{type}_e", c + new Vector3(half, h / 2, 0), new Vector3(t, h, 2 * half), m);
                    Box($"{type}_w", c + new Vector3(-half, h / 2, 0), new Vector3(t, h, 2 * half), m);
                    bins.Add(new Bin { Id = $"bin_room_{type}", Type = type, Center = c, Half = half, Height = h });
                }
                config["bins"] = bins.Select(b => $"{b.Id}@{b.Center.x:F2},{b.Center.z:F2} half={b.Half:F2} h={b.Height:F2}").ToList();
            }

            void BuildCamera()
            {
                // corner mount looking down at the bins
                float sx = rng.NextDouble() < 0.5 ? -1 : 1;
                var pos = new Vector3(sx * (roomW / 2 - 0.15f), R(2.4f, Mathf.Min(3.0f, roomH - 0.1f)), -roomD / 2 + 0.15f);
                cam = new GameObject("camera").AddComponent<Camera>();
                cam.transform.position = pos;
                var mid = (bins[0].Center + bins[1].Center) / 2 + new Vector3(R(-0.6f, 0.6f), R(0.2f, 0.6f), 0);
                cam.transform.LookAt(mid);
                cam.fieldOfView = Camera.HorizontalToVerticalFieldOfView(R(80, 110), (float)W / H);
                cam.nearClipPlane = 0.05f;
                cam.clearFlags = CameraClearFlags.SolidColor; cam.backgroundColor = Color.black;
                config["camera"] = $"pos={pos} hfov={Camera.VerticalToHorizontalFieldOfView(cam.fieldOfView, (float)W / H):F0}";
            }

            // ---------------- items ----------------

            static readonly string[] Kinds = { "clear_cup", "paper_cup", "bottle", "can", "glass", "container", "box", "paper", "wrapper", "utensil", "napkin", "food", "sauce_cup", "receipt" };
            static readonly Dictionary<string, string> Catalog = new()
            {
                ["clear_cup"] = "item_generic_cup", ["paper_cup"] = "item_generic_paper_cup", ["bottle"] = "item_generic_bottle",
                ["can"] = "item_generic_can", ["glass"] = "item_generic_glass", ["container"] = "item_generic_container",
                ["box"] = "item_generic_box", ["paper"] = "item_generic_paper", ["wrapper"] = "item_generic_wrapper",
                ["utensil"] = "item_generic_utensil", ["napkin"] = "item_napkin", ["food"] = "item_generic_food",
                ["sauce_cup"] = "item_sauce_cup", ["receipt"] = null,
            };

            Item MakeItem(string kind, Vector3 pos)
            {
                GameObject g; float mass;
                switch (kind)
                {
                    case "clear_cup": g = Prim(PrimitiveType.Cylinder, new Vector3(0.09f, 0.075f, 0.09f), Mat(new Color(0.85f, 0.9f, 0.95f, 0.35f), 0.9f, true)); mass = 0.03f; break;
                    case "paper_cup": g = Prim(PrimitiveType.Cylinder, new Vector3(0.085f, 0.07f, 0.085f), Mat(Pick(new[] { Color.white, new Color(0.6f, 0.45f, 0.3f), new Color(0.2f, 0.5f, 0.3f) }))); mass = 0.02f; break;
                    case "bottle": g = Prim(PrimitiveType.Capsule, new Vector3(0.07f, 0.11f, 0.07f), Mat(new Color(0.7f, 0.85f, 0.95f, 0.5f), 0.9f, true)); mass = 0.03f; break;
                    case "can": g = Prim(PrimitiveType.Cylinder, new Vector3(0.066f, 0.06f, 0.066f), Mat(RandColor(0.6f, 1, 0.5f, 1), 0.8f)); mass = 0.015f; break;
                    case "glass": g = Prim(PrimitiveType.Cylinder, new Vector3(0.08f, 0.07f, 0.08f), Mat(new Color(0.4f, 0.6f, 0.4f, 0.6f), 0.95f, true)); mass = 0.25f; break;
                    case "container": g = Prim(PrimitiveType.Cube, new Vector3(0.18f, 0.06f, 0.13f), Mat(new Color(0.9f, 0.9f, 0.92f, 0.6f), 0.7f, true)); mass = 0.04f; break;
                    case "box": g = Prim(PrimitiveType.Cube, new Vector3(0.16f, 0.08f, 0.1f), Mat(new Color(0.65f, 0.5f, 0.33f))); mass = 0.05f; break;
                    case "paper": g = Prim(PrimitiveType.Cube, new Vector3(0.21f, 0.004f, 0.28f), Mat(Color.white * 0.95f)); mass = 0.01f; break;
                    case "wrapper": g = Prim(PrimitiveType.Cube, new Vector3(0.13f, 0.03f, 0.08f), Mat(RandColor(0.6f, 1, 0.6f, 1), 0.6f)); mass = 0.008f; break;
                    case "utensil": g = Prim(PrimitiveType.Cube, new Vector3(0.016f, 0.004f, 0.16f), Mat(Pick(new[] { Color.white, Color.black }))); mass = 0.004f; break;
                    case "napkin": g = Prim(PrimitiveType.Sphere, new Vector3(0.07f, 0.05f, 0.07f), Mat(Color.white * 0.97f)); mass = 0.003f; break;
                    case "food": g = Prim(PrimitiveType.Capsule, new Vector3(0.04f, 0.08f, 0.04f), Mat(new Color(0.95f, 0.8f, 0.2f))); mass = 0.1f; break;
                    case "sauce_cup": g = Prim(PrimitiveType.Cylinder, new Vector3(0.05f, 0.02f, 0.05f), Mat(new Color(0.95f, 0.9f, 0.7f, 0.6f), 0.8f, true)); mass = 0.03f; break;
                    default: g = Prim(PrimitiveType.Sphere, new Vector3(0.06f, 0.06f, 0.06f), Mat(Color.white * 0.92f)); mass = 0.004f; break; // receipt ball
                }
                g.name = $"item_{items.Count}_{kind}";
                g.transform.position = pos;
                g.transform.localScale *= R(0.85f, 1.15f);
                var rb = g.AddComponent<Rigidbody>();
                rb.mass = mass; rb.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic; rb.isKinematic = true;
                rb.linearDamping = kind is "napkin" or "receipt" or "wrapper" or "paper" ? 0.8f : 0.05f;
                var it = new Item { Kind = kind, CatalogId = Catalog[kind], Go = g, Rb = rb };
                items.Add(it);
                return it;
            }

            GameObject Prim(PrimitiveType t, Vector3 scale, Material m)
            {
                var g = GameObject.CreatePrimitive(t);
                g.transform.localScale = scale;
                g.GetComponent<Renderer>().sharedMaterial = m;
                return g;
            }

            GameObject Person()
            {
                var body = Prim(PrimitiveType.Capsule, new Vector3(0.45f, 0.85f, 0.35f), Mat(RandColor(0, 0.7f, 0.15f, 0.8f)));
                UnityEngine.Object.DestroyImmediate(body.GetComponent<Collider>()); // people occlude, they don't push items
                var head = Prim(PrimitiveType.Sphere, new Vector3(0.22f, 0.25f, 0.22f), Mat(new Color(0.85f, 0.65f, 0.5f) * R(0.5f, 1.1f)));
                UnityEngine.Object.DestroyImmediate(head.GetComponent<Collider>());
                head.transform.SetParent(body.transform); head.transform.localPosition = new Vector3(0, 1.15f, 0);
                return body;
            }

            // ---------------- scenarios (shares fixed in docs/sim/unity-sim-brief.md §4) ----------------

            static readonly (string name, int weight)[] Scenarios =
            {
                ("clean", 25), ("toss", 10), ("rim_in", 8), ("rim_out", 8), ("drop_next_to", 5), ("carried_away", 8),
                ("simultaneous", 6), ("passerby", 8), ("fast", 6), ("tiny", 5), ("floor_kick", 3), ("distractor", 4),
            };

            string PickScenario()
            {
                int total = Scenarios.Sum(s => s.weight), r = rng.Next(total);
                foreach (var (name, w) in Scenarios) { if (r < w) return name; r -= w; }
                return "clean";
            }

            void PlanThrows()
            {
                int n = rng.Next(2, 6); float t = 2.5f; // >= 2 s of empty scene first
                for (int i = 0; i < n; i++)
                {
                    var sc = PickScenario();
                    int count = sc == "simultaneous" ? 2 : 1;
                    for (int k = 0; k < count; k++) AddThrow(sc, t, i);
                    t += R(4, 7);
                }
                duration = t + 3;
                config["scenarios"] = throws.Select(x => x.Scenario).ToList();
            }

            void AddThrow(string sc, float t, int index)
            {
                var target = Pick(bins);
                string kind = sc == "tiny" ? Pick(new[] { "utensil", "sauce_cup" }) : sc == "distractor" ? "receipt" : Kinds[rng.Next(Kinds.Length)];
                var person = Person();
                var start = new Vector3(R(-roomW / 2 + 0.6f, roomW / 2 - 0.6f), 0.85f, R(-roomD / 2 + 0.6f, 0));
                var opening = target.Center + new Vector3(0, target.Height, 0);
                float standOff = sc == "toss" ? R(1.0f, 2.0f) : R(0.35f, 0.6f);
                var dir2 = new Vector3(start.x - opening.x, 0, start.z - opening.z).normalized;
                var stand = new Vector3(opening.x, 0.85f, opening.z) + dir2 * (standOff + target.Half);
                var hand = stand + new Vector3(0, R(0.25f, 0.45f), 0) - dir2 * 0.3f;
                var item = MakeItem(kind, hand);
                item.Scenario = sc; item.ThrowIndex = index; item.IntendedBin = target.Id;
                var th = new Throw { Scenario = sc, Item = item, Start = t, Target = target.Id, From = start, Release = hand, Person = person };
                th.ReleaseAt = t + R(1.5f, 2.5f);
                item.ReleaseAt = th.ReleaseAt;
                th.CarryAway = sc is "carried_away" or "distractor";
                th.EndAt = th.ReleaseAt + (th.CarryAway ? 2.5f : 1.5f);
                throws.Add(th);
                if (sc == "floor_kick") { item.Go.transform.position = new Vector3(opening.x + R(-0.6f, 0.6f), 0.05f, opening.z - target.Half - R(0.2f, 0.6f)); }
                if (sc == "passerby")
                {
                    var p = Person();
                    var y = 0.85f; var z = (cam.transform.position.z + opening.z) / 2;
                    walkers.Add((p, new Vector3(-roomW / 2, y, z), new Vector3(roomW / 2, y, z), th.ReleaseAt - 1.2f, th.ReleaseAt + 1.8f));
                }
                person.SetActive(false);
            }

            Vector3 ReleaseVelocity(Throw th)
            {
                var bin = bins.First(b => b.Id == th.Target);
                var aim = bin.Center + new Vector3(0, bin.Height + 0.05f, 0);
                float flight = th.Scenario == "fast" ? R(0.12f, 0.2f) : th.Scenario == "toss" ? R(0.6f, 0.9f) : R(0.25f, 0.45f);
                switch (th.Scenario)
                {
                    case "rim_in": aim += new Vector3(R(-1, 1), 0, R(-1, 1)).normalized * bin.Half * R(0.75f, 0.95f); break;
                    case "rim_out": aim += new Vector3(R(-1, 1), 0, R(-1, 1)).normalized * bin.Half * R(1.05f, 1.35f); break;
                    case "drop_next_to": aim += new Vector3(R(-1, 1), 0, R(-1, 1)).normalized * bin.Half * R(1.6f, 2.5f) - new Vector3(0, bin.Height, 0); break;
                    default: aim += new Vector3(R(-1, 1), 0, R(-1, 1)) * bin.Half * 0.4f; break;
                }
                var d = aim - th.Release;
                return new Vector3(d.x / flight, (d.y - 0.5f * Physics.gravity.y * flight * flight) / flight, d.z / flight);
            }

            // ---------------- simulation + capture ----------------

            readonly List<string> yolo = new();

            void Simulate()
            {
                var rt = new RenderTexture(W, H, 24); var tex = new Texture2D(W, H, TextureFormat.RGB24, false);
                cam.targetTexture = rt;
                int frames = Mathf.CeilToInt(duration * Fps);
                float dt = 1f / (Fps * PhysicsPerFrame);
                for (int f = 0; f < frames; f++)
                {
                    float t = f / (float)Fps;
                    Choreograph(t);
                    for (int k = 0; k < PhysicsPerFrame; k++) Physics.Simulate(dt);
                    TrackGroundTruth(t);
                    cam.Render();
                    RenderTexture.active = rt;
                    tex.ReadPixels(new Rect(0, 0, W, H), 0, 0); tex.Apply();
                    File.WriteAllBytes(Path.Combine(dir, "frames", $"{f:D5}.png"), tex.EncodeToPNG());
                    if (f % 3 == 0) yolo.Add($"{f:D5}\t" + string.Join(";", Boxes()));
                }
                RenderTexture.active = null;
            }

            void Choreograph(float t)
            {
                foreach (var th in throws)
                {
                    bool active = t >= th.Start && t <= th.EndAt + 1.5f;
                    th.Person.SetActive(active);
                    // An item exists from its throw's start (floor_kick items lie there from the beginning);
                    // carried-away items leave with their carrier.
                    bool itemVisible = th.Scenario == "floor_kick" || (t >= th.Start && (!th.CarryAway || t <= th.EndAt + 1.5f));
                    if (th.Item.Go.activeSelf != itemVisible) th.Item.Go.SetActive(itemVisible);
                    if (!active) continue;
                    // walk to the release point, then stand; carried-away people walk back out with the item
                    float walk = Mathf.Clamp01((t - th.Start) / Mathf.Max(0.1f, th.ReleaseAt - th.Start));
                    var stand = th.Release + new Vector3(0, -0.4f, 0);
                    Vector3 body = Vector3.Lerp(th.From, new Vector3(stand.x, 0.85f, stand.z) + (th.From - stand).normalized * 0.25f, walk);
                    if (th.CarryAway && t > th.ReleaseAt + 0.8f)
                        body = Vector3.Lerp(new Vector3(stand.x, 0.85f, stand.z), th.From, Mathf.Clamp01((t - th.ReleaseAt - 0.8f) / 1.5f));
                    th.Person.transform.position = new Vector3(body.x, 0.85f, body.z);
                    var handPos = th.Person.transform.position + (th.Release - new Vector3(stand.x, 0.85f, stand.z) + new Vector3(0, -0.4f, 0)) + new Vector3(0, 0.4f, 0);
                    if (th.Scenario == "floor_kick") continue;
                    if (!th.Released && (th.CarryAway || t < th.ReleaseAt))
                    {
                        th.Item.Rb.isKinematic = true;
                        th.Item.Go.transform.position = th.CarryAway && t > th.ReleaseAt ? handPos : Vector3.Lerp(th.From + new Vector3(0, 0.3f, 0), th.Release, walk);
                    }
                    else if (!th.Released)
                    {
                        th.Released = true;
                        th.Item.Rb.isKinematic = false;
                        th.Item.Rb.linearVelocity = ReleaseVelocity(th);
                        th.Item.Rb.angularVelocity = new Vector3(R(-6, 6), R(-6, 6), R(-6, 6));
                    }
                }
                foreach (var w in walkers)
                {
                    bool on = t >= w.t0 && t <= w.t1;
                    w.go.SetActive(on);
                    if (on) w.go.transform.position = Vector3.Lerp(w.a, w.b, (t - w.t0) / (w.t1 - w.t0));
                }
            }

            void TrackGroundTruth(float t)
            {
                foreach (var it in items)
                {
                    if (it.LabeledBin != null || !it.Go.activeInHierarchy) continue;
                    var p = it.Go.transform.position;
                    var inside = bins.FirstOrDefault(b => Mathf.Abs(p.x - b.Center.x) < b.Half && Mathf.Abs(p.z - b.Center.z) < b.Half && p.y < b.Height && p.y > 0);
                    if (inside == null || it.Rb.isKinematic) { it.InsideSince = -1; continue; }
                    if (it.InsideSince < 0) it.InsideSince = t;
                    if (t - it.InsideSince >= 0.5f) { it.LabeledBin = inside.Id; it.LabeledAt = it.InsideSince; }
                }
            }

            IEnumerable<string> Boxes()
            {
                foreach (var it in items)
                {
                    if (!it.Go.activeInHierarchy) continue;
                    var r = it.Go.GetComponent<Renderer>().bounds;
                    if (!Visible(r)) continue;
                    if (ScreenBox(r, out var b)) yield return $"0 {b.x:F5} {b.y:F5} {b.z:F5} {b.w:F5}";
                }
                foreach (var th in throws.Where(x => x.Person.activeInHierarchy))
                    if (ScreenBox(th.Person.GetComponent<Renderer>().bounds, out var b)) yield return $"1 {b.x:F5} {b.y:F5} {b.z:F5} {b.w:F5}";
            }

            bool Visible(Bounds bnd)
            {
                // fraction of sample points with a clear line of sight from the camera (>= 20% counts)
                int seen = 0, total = 0; var c = cam.transform.position;
                for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++)
                {
                    var p = bnd.center + Vector3.Scale(bnd.extents * 0.8f, new Vector3(i, j, i * j == 0 ? 1 : -1));
                    total++;
                    if (!Physics.Linecast(c, p, out var hit) || hit.collider.bounds.Intersects(bnd)) seen++;
                }
                return seen / (float)total >= 0.2f;
            }

            bool ScreenBox(Bounds bnd, out Vector4 box)
            {
                float x0 = 1, y0 = 1, x1 = 0, y1 = 0; bool any = false;
                for (int i = 0; i < 8; i++)
                {
                    var corner = bnd.center + Vector3.Scale(bnd.extents, new Vector3((i & 1) == 0 ? -1 : 1, (i & 2) == 0 ? -1 : 1, (i & 4) == 0 ? -1 : 1));
                    var v = cam.WorldToViewportPoint(corner);
                    if (v.z <= 0) continue;
                    any = true;
                    x0 = Mathf.Min(x0, v.x); x1 = Mathf.Max(x1, v.x); y0 = Mathf.Min(y0, 1 - v.y); y1 = Mathf.Max(y1, 1 - v.y);
                }
                x0 = Mathf.Clamp01(x0); x1 = Mathf.Clamp01(x1); y0 = Mathf.Clamp01(y0); y1 = Mathf.Clamp01(y1);
                box = new Vector4((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0);
                return any && box.z > 0.002f && box.w > 0.002f;
            }

            // ---------------- outputs (packed into the contract format by sim/unity-mac/pack.py) ----------------

            void WriteOutputs()
            {
                var sb = new StringBuilder();
                sb.Append("{\"seed\":").Append(seed).Append(",\"split\":\"").Append(split).Append("\",\"fps\":").Append(Fps)
                  .Append(",\"width\":").Append(W).Append(",\"height\":").Append(H).Append(",\"frames\":").Append(Mathf.CeilToInt(duration * Fps));
                sb.Append(",\"lighting\":\"").Append(config["lighting"]).Append("\",\"camera\":\"").Append(config["camera"]).Append('"');
                sb.Append(",\"bins\":[");
                sb.Append(string.Join(",", bins.Select(b =>
                {
                    // screen-space bbox of the bin's rim (the opening), normalized, y down
                    float x0 = 1, y0 = 1, x1 = 0, y1 = 0;
                    foreach (var sx in new[] { -1, 1 }) foreach (var sz in new[] { -1, 1 })
                    {
                        var v = cam.WorldToViewportPoint(b.Center + new Vector3(sx * b.Half, b.Height, sz * b.Half));
                        x0 = Mathf.Min(x0, v.x); x1 = Mathf.Max(x1, v.x); y0 = Mathf.Min(y0, 1 - v.y); y1 = Mathf.Max(y1, 1 - v.y);
                    }
                    string F(float v) => v.ToString("F4", Inv);
                    return "{\"bin_id\":\"" + b.Id + "\",\"type\":\"" + b.Type + "\",\"x\":" + F(Mathf.Clamp01(x0)) + ",\"y\":" + F(Mathf.Clamp01(y0))
                        + ",\"w\":" + F(Mathf.Clamp01(x1) - Mathf.Clamp01(x0)) + ",\"h\":" + F(Mathf.Clamp01(y1) - Mathf.Clamp01(y0)) + "}";
                })));
                sb.Append("],\"items\":[");
                sb.Append(string.Join(",", items.Select(it =>
                    "{\"kind\":\"" + it.Kind + "\",\"catalog_item_id\":" + (it.CatalogId == null ? "null" : "\"" + it.CatalogId + "\"")
                    + ",\"scenario\":\"" + it.Scenario + "\",\"intended_bin\":\"" + it.IntendedBin + "\",\"labeled_bin\":"
                    + (it.LabeledBin == null ? "null" : "\"" + it.LabeledBin + "\"") + ",\"labeled_at\":" + it.LabeledAt.ToString("F3", Inv) + ",\"release_at\":" + it.ReleaseAt.ToString("F3", Inv) + "}")));
                sb.Append("]}");
                File.WriteAllText(Path.Combine(dir, "unity.json"), sb.ToString());
                File.WriteAllLines(Path.Combine(dir, "yolo_boxes.tsv"), yolo);
            }
        }
    }
}
