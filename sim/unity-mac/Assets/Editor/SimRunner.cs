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
    /// v2 (realism pass). Builds a randomized room from a seed: textured walls/floor, a corner security
    /// camera, one trash + one recycling bin (square or round, liner, old trash inside, optional swing
    /// lid), jointed people who carry items in their hand, textured product-like items. Physics is
    /// stepped by hand; ground truth comes from the physics. Clean PNG frames + unity.json are written;
    /// CCTV effects and conditions are applied by pack.py.
    ///   Unity -batchmode -quit -projectPath sim/unity-mac -executeMethod Recyclone.SimRunner.Render
    ///         -seedStart 1000 -seedEnd 1009 -split dev -out Output
    /// Scenario shares: docs/sim/unity-sim-brief.md §4 (v2).
    /// </summary>
    public static class SimRunner
    {
        public const string Version = "v2";
        const int Fps = 30, PhysicsPerFrame = 4, W = 1280, H = 720;
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        static string projectDir;

        public static void Render()
        {
            var a = Args();
            int s0 = int.Parse(a.GetValueOrDefault("seedStart", "0")), s1 = int.Parse(a.GetValueOrDefault("seedEnd", "0"));
            string split = a.GetValueOrDefault("split", "dev"), outRoot = a.GetValueOrDefault("out", "Output");
            projectDir = Directory.GetCurrentDirectory();
            Physics.simulationMode = SimulationMode.Script;
            for (int seed = s0; seed <= s1; seed++)
            {
                var dir = Path.Combine(outRoot, split, $"sim_{split}_{seed:D4}");
                Directory.CreateDirectory(Path.Combine(dir, "frames"));
                new Clip(seed, split, dir).Run();
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

        static readonly Dictionary<string, Texture2D> TexCache = new();

        static Texture2D LoadTex(string path)
        {
            if (TexCache.TryGetValue(path, out var t)) return t;
            if (!File.Exists(path)) { TexCache[path] = null; return null; }
            t = new Texture2D(2, 2, TextureFormat.RGB24, true) { name = Path.GetFileNameWithoutExtension(path) };
            t.LoadImage(File.ReadAllBytes(path));
            t.wrapMode = TextureWrapMode.Repeat;
            TexCache[path] = t;
            return t;
        }

        static string[] Files(string rel, string pattern) =>
            Directory.Exists(Path.Combine(projectDir, rel)) ? Directory.GetFiles(Path.Combine(projectDir, rel), pattern).OrderBy(x => x).ToArray() : new string[0];

        // ------------------------------------------------------------------------------------------

        class Item
        {
            public string Kind, CatalogId; public GameObject Go; public Rigidbody Rb; public int Index;
            public string Scenario; public string IntendedBin; public float ReleaseAt = -1;
            public float InsideSince = -1; public string LabeledBin; public float LabeledAt = -1;
        }

        class Body
        {
            public GameObject Root, Torso, Head, LUpper, LLower, RUpper, RLower, LThigh, LShin, RThigh, RShin;
            public float Phase;
        }

        class Throw
        {
            public string Scenario; public List<Item> Items = new(); public float Start, ReleaseAt, EndAt;
            public string Target; public Vector3 From, Stand; public Body Person;
            public bool Released, CarryAway; public float RaiseHeight;
        }

        class Bin { public string Id, Type; public Vector3 Center; public float Half, Height; public bool Round, Lid; }

        class Clip
        {
            readonly Random rng; readonly int seed; readonly string split, dir;
            readonly List<Bin> bins = new(); readonly List<Item> items = new(); readonly List<Throw> throws = new();
            readonly List<(Body body, Vector3 a, Vector3 b, float t0, float t1, Item carried)> walkers = new();
            readonly List<(GameObject go, Vector3 a, Vector3 b, float t0, float t1)> movers = new();
            readonly Dictionary<string, string> config = new();
            readonly List<Light> flicker = new();
            Camera cam; float roomW, roomD, roomH, duration;

            public Clip(int seed, string split, string dir) { this.seed = seed; this.split = split; this.dir = dir; rng = new Random(seed); }

            float R(float lo, float hi) => (float)(lo + rng.NextDouble() * (hi - lo));
            T Pick<T>(IList<T> xs) => xs[rng.Next(xs.Count)];
            bool Chance(double p) => rng.NextDouble() < p;

            public void Run()
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene);
                Physics.gravity = new Vector3(0, -9.81f, 0);
                BuildRoom(); BuildBins(); BuildCamera(); PlanThrows(); PlanDistractors(); Simulate(); WriteOutputs();
            }

            // ---------------- materials / meshes ----------------

            Material Mat(Color c, float smooth = 0.2f, bool transparent = false, Texture2D tex = null, Vector2? tiling = null)
            {
                var m = new Material(Shader.Find("Standard")) { color = c };
                m.SetFloat("_Glossiness", smooth);
                if (tex != null) { m.mainTexture = tex; m.mainTextureScale = tiling ?? Vector2.one; }
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

            GameObject Prim(PrimitiveType t, Vector3 scale, Material m, bool collider = false)
            {
                var g = GameObject.CreatePrimitive(t);
                g.transform.localScale = scale;
                g.GetComponent<Renderer>().sharedMaterial = m;
                if (!collider) UnityEngine.Object.DestroyImmediate(g.GetComponent<Collider>());
                return g;
            }

            /// <summary>Open-top tapered cylinder (cup), height along +Y, centered at origin.</summary>
            static Mesh Frustum(float rBottom, float rTop, float h, int seg = 20)
            {
                var v = new List<Vector3>(); var uv = new List<Vector2>(); var tri = new List<int>();
                for (int i = 0; i <= seg; i++)
                {
                    float a = i * Mathf.PI * 2 / seg;
                    v.Add(new Vector3(Mathf.Cos(a) * rBottom, -h / 2, Mathf.Sin(a) * rBottom)); uv.Add(new Vector2(i / (float)seg, 0));
                    v.Add(new Vector3(Mathf.Cos(a) * rTop, h / 2, Mathf.Sin(a) * rTop)); uv.Add(new Vector2(i / (float)seg, 1));
                }
                for (int i = 0; i < seg; i++)
                {
                    int b = i * 2;
                    tri.AddRange(new[] { b, b + 1, b + 2, b + 1, b + 3, b + 2 });
                    tri.AddRange(new[] { b, b + 2, b + 1, b + 1, b + 2, b + 3 }); // inside faces too
                }
                int c = v.Count; v.Add(new Vector3(0, -h / 2, 0)); uv.Add(new Vector2(0.5f, 0.5f));
                for (int i = 0; i < seg; i++) tri.AddRange(new[] { c, i * 2, (i + 1) * 2, c, (i + 1) * 2, i * 2 });
                var m = new Mesh(); m.SetVertices(v); m.SetUVs(0, uv); m.SetTriangles(tri, 0); m.RecalculateNormals(); m.RecalculateBounds();
                return m;
            }

            /// <summary>A cube with jittered vertices: a crumpled wrapper or bag.</summary>
            Mesh Crumpled()
            {
                var src = Resources.GetBuiltinResource<Mesh>("Cube.fbx");
                var m = UnityEngine.Object.Instantiate(src);
                var verts = m.vertices;
                var jitter = new Dictionary<Vector3, Vector3>();
                for (int i = 0; i < verts.Length; i++)
                {
                    if (!jitter.TryGetValue(verts[i], out var j)) jitter[verts[i]] = j = new Vector3(R(-0.18f, 0.18f), R(-0.25f, 0.25f), R(-0.18f, 0.18f));
                    verts[i] += j;
                }
                m.vertices = verts; m.RecalculateNormals(); m.RecalculateBounds();
                return m;
            }

            GameObject MeshObject(string name, Mesh mesh, Material mat, bool collider)
            {
                var g = new GameObject(name);
                g.AddComponent<MeshFilter>().sharedMesh = mesh;
                g.AddComponent<MeshRenderer>().sharedMaterial = mat;
                if (collider) { var mc = g.AddComponent<MeshCollider>(); mc.sharedMesh = mesh; mc.convex = true; }
                return g;
            }

            // ---------------- room ----------------

            void BuildRoom()
            {
                roomW = R(4, 8); roomD = R(4, 7); roomH = R(2.6f, 3.2f);
                var floorTex = Files("Assets/Textures", "*floor*.jpg").Concat(Files("Assets/Textures", "*tiles*.jpg")).ToArray();
                var wallTex = Files("Assets/Textures", "*wall*.jpg").Concat(Files("Assets/Textures", "*plaster*.jpg")).Distinct().ToArray();
                var ft = floorTex.Length > 0 ? LoadTex(Pick(floorTex)) : null;
                var wt = wallTex.Length > 0 && Chance(0.8) ? LoadTex(Pick(wallTex)) : null;
                var floor = Mat(Color.white * R(0.7f, 1f), R(0.1f, 0.5f), false, ft, new Vector2(roomW / 1.5f, roomD / 1.5f));
                var wallTint = Color.Lerp(Color.white, RandColor(0, 0.3f, 0.7f, 1f), R(0, 0.6f));
                var wall = Mat(wallTint, 0.1f, false, wt, new Vector2(roomW / 2, roomH / 2));
                var sideWall = Mat(wallTint, 0.1f, false, wt, new Vector2(roomD / 2, roomH / 2)); // tile by each wall's own length
                config["floor"] = ft != null ? ft.name : "plain";
                config["walls"] = wt != null ? wt.name : "paint";
                Box("floor", new Vector3(0, -0.05f, 0), new Vector3(roomW, 0.1f, roomD), floor);
                Box("ceiling", new Vector3(0, roomH + 0.05f, 0), new Vector3(roomW, 0.1f, roomD), Mat(Color.white * 0.9f));
                Box("wall_n", new Vector3(0, roomH / 2, roomD / 2), new Vector3(roomW, roomH, 0.1f), wall);
                Box("wall_s", new Vector3(0, roomH / 2, -roomD / 2), new Vector3(roomW, roomH, 0.1f), wall);
                Box("wall_e", new Vector3(roomW / 2, roomH / 2, 0), new Vector3(0.1f, roomH, roomD), sideWall);
                Box("wall_w", new Vector3(-roomW / 2, roomH / 2, 0), new Vector3(0.1f, roomH, roomD), sideWall);
                Box("baseboard", new Vector3(0, 0.05f, roomD / 2 - 0.06f), new Vector3(roomW, 0.1f, 0.02f), Mat(Color.white * 0.85f), false);
                Box("door", new Vector3(Pick(new[] { -1f, 1f }) * roomW / 2 * 0.98f, 1.0f, R(-roomD / 3, roomD / 3)), new Vector3(0.04f, 2.0f, 0.9f), Mat(RandColor(0.1f, 0.5f, 0.3f, 0.8f), 0.3f), false);

                var wood = Mat(RandColor(0.3f, 0.6f, 0.3f, 0.6f), 0.3f);
                var tx = R(-roomW / 2 + 1, roomW / 2 - 1); var tz = R(-roomD / 2 + 1, -0.2f);
                Box("table_top", new Vector3(tx, 0.74f, tz), new Vector3(R(0.8f, 1.6f), 0.04f, R(0.6f, 1f)), wood, false);
                foreach (var dx in new[] { -0.35f, 0.35f }) foreach (var dz in new[] { -0.25f, 0.25f })
                    Box("table_leg", new Vector3(tx + dx, 0.37f, tz + dz), new Vector3(0.05f, 0.74f, 0.05f), wood, false);
                int chairs = rng.Next(1, 5);
                for (int i = 0; i < chairs; i++)
                {
                    var cm = Mat(RandColor(0, 0.8f, 0.2f, 0.9f));
                    var cp = new Vector3(tx + R(-1, 1), 0, tz + R(-1, 1));
                    var seat = Box($"chair_{i}", cp + new Vector3(0, 0.45f, 0), new Vector3(0.45f, 0.05f, 0.45f), cm, false);
                    var back = Box($"chair_{i}_back", cp + new Vector3(0, 0.7f, 0.2f), new Vector3(0.45f, 0.5f, 0.05f), cm, false);
                    back.transform.SetParent(seat.transform, true);
                    if (i == 0 && Chance(0.3)) movers.Add((seat, seat.transform.position, seat.transform.position + new Vector3(R(-0.5f, 0.5f), 0, R(-0.4f, 0.4f)), R(3, 15), 0));
                }
                var posterTex = Files("LocalTextures/products", "*.jpg");
                Box("poster", new Vector3(R(-roomW / 3, roomW / 3), R(1.4f, 2f), roomD / 2 - 0.06f), new Vector3(R(0.4f, 1f), R(0.5f, 0.9f), 0.01f),
                    Mat(Color.white, 0.2f, false, posterTex.Length > 0 && Chance(0.5) ? LoadTex(Pick(posterTex)) : null), false);

                var mood = Pick(new[] { "bright", "bright", "warm", "dim", "daylight", "flicker" });
                config["lighting"] = mood;
                RenderSettings.ambientLight = mood == "dim" ? new Color(0.1f, 0.1f, 0.12f) : new Color(0.3f, 0.3f, 0.33f) * R(0.8f, 1.2f);
                int n = rng.Next(1, 5);
                for (int i = 0; i < n; i++)
                {
                    var l = new GameObject($"light_{i}").AddComponent<Light>();
                    l.type = LightType.Point; l.range = 9; l.shadows = LightShadows.Soft;
                    l.intensity = mood == "dim" ? R(0.25f, 0.5f) : R(0.9f, 1.6f);
                    l.color = mood == "warm" ? new Color(1f, 0.82f, 0.65f) : new Color(1f, 0.98f, 0.95f);
                    l.transform.position = new Vector3(R(-roomW / 3, roomW / 3), roomH - 0.1f, R(-roomD / 3, roomD / 3));
                    if (mood == "flicker" && i == 0) flicker.Add(l);
                }
                if (mood == "daylight")
                {
                    var sun = new GameObject("sun").AddComponent<Light>();
                    sun.type = LightType.Directional; sun.intensity = R(0.6f, 1.3f); sun.shadows = LightShadows.Hard;
                    sun.transform.rotation = Quaternion.Euler(R(25, 60), R(0, 360), 0);
                }
            }

            // ---------------- bins ----------------

            void BuildBins()
            {
                float gap = R(0.3f, 1.5f), half = R(0.2f, 0.3f), h = R(0.6f, 1.0f);
                bool round = Chance(0.4), lid = Chance(0.15);
                float cx = R(-roomW / 2 + 1.2f, roomW / 2 - 1.2f - gap), z = roomD / 2 - half - R(0.05f, 0.4f);
                var order = Chance(0.5) ? new[] { "trash", "recycling" } : new[] { "recycling", "trash" };
                for (int i = 0; i < 2; i++)
                {
                    var type = order[i];
                    var c = new Vector3(cx + i * (2 * half + gap), 0, z);
                    var m = Mat(type == "trash" ? new Color(0.18f, 0.18f, 0.2f) * R(0.7f, 1.5f) : new Color(0.1f, 0.35f, 0.75f) * R(0.8f, 1.2f), 0.35f);
                    float t = 0.02f;
                    Box($"{type}_bottom", c + new Vector3(0, t / 2, 0), new Vector3(2 * half, t, 2 * half), m);
                    int sides = round ? 12 : 4;
                    for (int s = 0; s < sides; s++)
                    {
                        float ang = s * 360f / sides;
                        float apothem = round ? half * Mathf.Cos(Mathf.PI / sides) : half;
                        float width = round ? 2 * half * Mathf.Sin(Mathf.PI / sides) + 0.01f : 2 * half;
                        var wallGo = Box($"{type}_wall_{s}", c + Quaternion.Euler(0, ang, 0) * new Vector3(0, h / 2, apothem), new Vector3(width, h, t), m);
                        wallGo.transform.rotation = Quaternion.Euler(0, ang, 0);
                    }
                    Box($"{type}_liner", c + new Vector3(0, h - 0.02f, 0), new Vector3(2 * half + 0.03f, 0.04f, 2 * half + 0.03f), Mat(new Color(0.05f, 0.05f, 0.06f), 0.6f), false);
                    Box($"{type}_label", c + new Vector3(0, h * 0.6f, -half - 0.012f), new Vector3(half, half * 0.6f, 0.005f),
                        Mat(type == "trash" ? Color.white * 0.8f : new Color(0.9f, 0.95f, 1f)), false);
                    int k = rng.Next(0, 6); // old trash already inside: present before any throw, not ground truth
                    for (int j = 0; j < k; j++)
                    {
                        var o = Prim(PrimitiveType.Cube, new Vector3(R(0.04f, 0.12f), R(0.02f, 0.06f), R(0.04f, 0.12f)), Mat(RandColor(0, 0.8f, 0.3f, 1f)));
                        o.transform.position = c + new Vector3(R(-half * 0.6f, half * 0.6f), R(0.03f, h * 0.4f), R(-half * 0.6f, half * 0.6f));
                        o.transform.rotation = Quaternion.Euler(R(0, 360), R(0, 360), R(0, 360));
                    }
                    if (lid)
                    {
                        var lidGo = Box($"{type}_lid", c + new Vector3(0, h + 0.01f, 0), new Vector3(2 * half * 0.95f, 0.015f, 2 * half * 0.95f), m);
                        var rb = lidGo.AddComponent<Rigidbody>(); rb.mass = 0.05f;
                        var hinge = lidGo.AddComponent<HingeJoint>();
                        hinge.anchor = new Vector3(0, 0, 0.5f); hinge.axis = Vector3.right;
                        hinge.useLimits = true; hinge.limits = new JointLimits { min = -85, max = 5 };
                        hinge.useSpring = true; hinge.spring = new JointSpring { spring = 0.15f, damper = 0.05f, targetPosition = 0 };
                    }
                    bins.Add(new Bin { Id = $"bin_room_{type}", Type = type, Center = c, Half = half, Height = h, Round = round, Lid = lid });
                }
                config["bin_style"] = $"{(round ? "round" : "square")}{(lid ? "+lid" : "")} half={half:F2} h={h:F2} gap={gap:F2}";
            }

            void BuildCamera()
            {
                float sx = Chance(0.5) ? -1 : 1;
                var pos = new Vector3(sx * (roomW / 2 - 0.15f), R(2.4f, Mathf.Min(3.0f, roomH - 0.1f)), -roomD / 2 + 0.15f);
                cam = new GameObject("camera").AddComponent<Camera>();
                cam.transform.position = pos;
                var mid = (bins[0].Center + bins[1].Center) / 2 + new Vector3(R(-0.6f, 0.6f), R(0.2f, 0.6f), 0);
                cam.transform.LookAt(mid);
                cam.fieldOfView = Camera.HorizontalToVerticalFieldOfView(R(80, 110), (float)W / H);
                cam.nearClipPlane = 0.05f;
                cam.clearFlags = CameraClearFlags.SolidColor; cam.backgroundColor = Color.black;
                config["camera"] = $"pos=({pos.x:F2};{pos.y:F2};{pos.z:F2}) hfov={Camera.VerticalToHorizontalFieldOfView(cam.fieldOfView, (float)W / H):F0}";
            }

            // ---------------- people (jointed, no colliders: they occlude, they don't push items) ----------------

            Body Person()
            {
                var skin = Mat(Color.Lerp(new Color(0.98f, 0.82f, 0.68f), new Color(0.35f, 0.22f, 0.15f), R(0, 1)), 0.3f);
                var shirt = Mat(RandColor(0, 0.8f, 0.15f, 0.9f), 0.2f);
                var pants = Mat(RandColor(0, 0.5f, 0.1f, 0.5f), 0.2f);
                var b = new Body { Root = new GameObject("person"), Phase = R(0, 6.28f) };
                b.Root.transform.localScale = Vector3.one * R(0.9f, 1.1f);
                GameObject Part(PrimitiveType t, Vector3 scale, Material m, Vector3 local)
                {
                    var g = Prim(t, scale, m); g.transform.SetParent(b.Root.transform, false); g.transform.localPosition = local; return g;
                }
                b.Torso = Part(PrimitiveType.Capsule, new Vector3(0.38f, 0.33f, 0.24f), shirt, new Vector3(0, 1.22f, 0));
                b.Head = Part(PrimitiveType.Sphere, new Vector3(0.21f, 0.24f, 0.22f), skin, new Vector3(0, 1.66f, 0));
                Part(PrimitiveType.Sphere, new Vector3(0.22f, 0.12f, 0.23f), Mat(RandColor(0, 0.5f, 0.05f, 0.5f)), new Vector3(0, 1.74f, 0));
                b.LThigh = Part(PrimitiveType.Capsule, new Vector3(0.14f, 0.22f, 0.14f), pants, new Vector3(-0.1f, 0.68f, 0));
                b.RThigh = Part(PrimitiveType.Capsule, new Vector3(0.14f, 0.22f, 0.14f), pants, new Vector3(0.1f, 0.68f, 0));
                b.LShin = Part(PrimitiveType.Capsule, new Vector3(0.12f, 0.22f, 0.12f), pants, new Vector3(-0.1f, 0.24f, 0));
                b.RShin = Part(PrimitiveType.Capsule, new Vector3(0.12f, 0.22f, 0.12f), pants, new Vector3(0.1f, 0.24f, 0));
                b.LUpper = Part(PrimitiveType.Capsule, new Vector3(0.09f, 0.16f, 0.09f), shirt, new Vector3(-0.24f, 1.3f, 0));
                b.LLower = Part(PrimitiveType.Capsule, new Vector3(0.08f, 0.15f, 0.08f), skin, new Vector3(-0.24f, 1.0f, 0));
                b.RUpper = Part(PrimitiveType.Capsule, new Vector3(0.09f, 0.16f, 0.09f), shirt, new Vector3(0.24f, 1.3f, 0));
                b.RLower = Part(PrimitiveType.Capsule, new Vector3(0.08f, 0.15f, 0.08f), skin, new Vector3(0.24f, 1.0f, 0));
                b.Root.SetActive(false);
                return b;
            }

            static void Segment(GameObject seg, Vector3 a, Vector3 b)
            {
                seg.transform.position = (a + b) / 2;
                seg.transform.up = (b - a).normalized;
                var sc = seg.transform.localScale; sc.y = Mathf.Max(0.05f, (b - a).magnitude / 2 / seg.transform.parent.localScale.y);
                seg.transform.localScale = sc;
            }

            /// <summary>Place the body at pos facing dir; legs swing when walking; right hand reaches handTarget.</summary>
            void Pose(Body b, Vector3 pos, Vector3 facing, bool walking, Vector3? handTarget, float t)
            {
                b.Root.transform.position = new Vector3(pos.x, 0, pos.z);
                if (new Vector3(facing.x, 0, facing.z).sqrMagnitude > 1e-4f) b.Root.transform.rotation = Quaternion.LookRotation(new Vector3(facing.x, 0, facing.z));
                float s = b.Root.transform.localScale.y;
                var tr = b.Root.transform;
                float swing = walking ? Mathf.Sin(t * 7f + b.Phase) * 0.35f : 0;
                foreach (var (thigh, shin, side, sgn) in new[] { (b.LThigh, b.LShin, -0.1f, 1f), (b.RThigh, b.RShin, 0.1f, -1f) })
                {
                    var hip = tr.TransformPoint(new Vector3(side, 0.92f, 0));
                    var knee = hip + tr.TransformDirection(new Vector3(0, -0.44f, Mathf.Sin(swing * sgn) * 0.44f)) * s;
                    var foot = knee + tr.TransformDirection(new Vector3(0, -0.44f, Mathf.Sin(swing * sgn * 0.5f) * 0.3f)) * s;
                    Segment(thigh, hip, knee); Segment(shin, knee, foot);
                }
                foreach (var (upper, lower, side, isRight) in new[] { (b.LUpper, b.LLower, -0.24f, false), (b.RUpper, b.RLower, 0.24f, true) })
                {
                    var shoulder = tr.TransformPoint(new Vector3(side, 1.42f, 0));
                    Vector3 hand = isRight && handTarget.HasValue
                        ? handTarget.Value
                        : shoulder + tr.TransformDirection(new Vector3(side * 0.2f, -0.6f, (isRight ? -1 : 1) * swing * 0.6f)) * s;
                    var reach = Mathf.Min((hand - shoulder).magnitude, 0.62f * s);
                    hand = shoulder + (hand - shoulder).normalized * reach;
                    float half = 0.31f * s, d = reach / 2;
                    float bend = Mathf.Sqrt(Mathf.Max(0, half * half - d * d));
                    var side3 = Vector3.Cross(hand - shoulder, Vector3.up);
                    var elbow = (shoulder + hand) / 2 + ((side3.sqrMagnitude > 1e-6f ? side3.normalized : tr.right) * (isRight ? 1 : -1) * 0.3f + Vector3.down).normalized * bend;
                    Segment(upper, shoulder, elbow); Segment(lower, elbow, hand);
                }
            }

            static Vector3 HandPoint(Body b, Vector3 bodyPos, Vector3 facing, float height, float forward)
            {
                var f = new Vector3(facing.x, 0, facing.z);
                f = f.sqrMagnitude > 1e-6f ? f.normalized : Vector3.forward;
                var right = Vector3.Cross(Vector3.up, f);
                return new Vector3(bodyPos.x, 0, bodyPos.z) + right * 0.22f + f * forward + Vector3.up * height * b.Root.transform.localScale.y;
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

            Texture2D ProductTex(params string[] names)
            {
                var all = Files("LocalTextures/products", "*.jpg").Where(f => names.Any(n => Path.GetFileName(f).StartsWith(n))).ToArray();
                return all.Length > 0 && Chance(0.75) ? LoadTex(Pick(all)) : null;
            }

            Item MakeItem(string kind)
            {
                GameObject g; float mass; string catalogId = Catalog[kind];
                switch (kind)
                {
                    case "clear_cup":
                    {
                        var tex = ProductTex("shakeshack_cup");
                        g = MeshObject("cup", Frustum(0.04f, 0.05f, 0.16f), Mat(new Color(0.9f, 0.93f, 0.96f, tex ? 0.75f : 0.35f), 0.9f, true, tex), true);
                        var lid = Prim(PrimitiveType.Cylinder, new Vector3(0.105f, 0.006f, 0.105f), Mat(new Color(0.9f, 0.92f, 0.95f, 0.5f), 0.9f, true));
                        lid.transform.SetParent(g.transform, false); lid.transform.localPosition = new Vector3(0, 0.082f, 0);
                        var straw = Prim(PrimitiveType.Cylinder, new Vector3(0.008f, 0.1f, 0.008f), Mat(Pick(new[] { new Color(0.3f, 0.75f, 0.3f), Color.white, Color.red })));
                        straw.transform.SetParent(g.transform, false); straw.transform.localPosition = new Vector3(0.01f, 0.12f, 0); straw.transform.localRotation = Quaternion.Euler(0, 0, 8);
                        if (tex != null && Chance(0.5)) catalogId = "item_shakeshack_cup";
                        mass = 0.03f; break;
                    }
                    case "paper_cup":
                        g = MeshObject("paper_cup", Frustum(0.03f, 0.045f, 0.12f), Mat(Pick(new[] { Color.white, new Color(0.6f, 0.45f, 0.3f), new Color(0.2f, 0.5f, 0.3f) })), true);
                        mass = 0.02f; break;
                    case "bottle":
                    {
                        var glassy = Mat(new Color(0.7f, 0.85f, 0.95f, 0.45f), 0.9f, true);
                        g = MeshObject("bottle", Frustum(0.033f, 0.033f, 0.17f), glassy, true);
                        var neck = MeshObject("neck", Frustum(0.033f, 0.013f, 0.05f), glassy, false);
                        neck.transform.SetParent(g.transform, false); neck.transform.localPosition = new Vector3(0, 0.11f, 0);
                        var cap = Prim(PrimitiveType.Cylinder, new Vector3(0.028f, 0.008f, 0.028f), Mat(RandColor(0.6f, 1, 0.5f, 1)));
                        cap.transform.SetParent(g.transform, false); cap.transform.localPosition = new Vector3(0, 0.14f, 0);
                        var label = Prim(PrimitiveType.Cylinder, new Vector3(0.068f, 0.03f, 0.068f), Mat(RandColor(0.5f, 1, 0.6f, 1)));
                        label.transform.SetParent(g.transform, false);
                        mass = 0.03f; break;
                    }
                    case "can":
                        g = MeshObject("can", Frustum(0.033f, 0.033f, 0.12f), Mat(RandColor(0.6f, 1, 0.5f, 1), 0.85f), true);
                        mass = 0.015f; break;
                    case "glass":
                        g = MeshObject("jar", Frustum(0.04f, 0.035f, 0.13f), Mat(new Color(0.45f, 0.6f, 0.45f, 0.55f), 0.95f, true), true);
                        mass = 0.25f; break;
                    case "container":
                        g = Prim(PrimitiveType.Cube, new Vector3(0.18f, 0.06f, 0.13f), Mat(new Color(0.92f, 0.92f, 0.94f, 0.55f), 0.7f, true), true);
                        mass = 0.04f; break;
                    case "box":
                    {
                        var tex = ProductTex("shakeshack_box");
                        g = Prim(PrimitiveType.Cube, new Vector3(0.18f, 0.08f, 0.1f), Mat(tex != null ? Color.white : new Color(0.65f, 0.5f, 0.33f), 0.2f, false, tex), true);
                        if (tex != null && Chance(0.5)) catalogId = "item_shakeshack_box";
                        mass = 0.05f; break;
                    }
                    case "paper":
                        g = Prim(PrimitiveType.Cube, new Vector3(0.21f, 0.004f, 0.28f), Mat(Color.white * 0.95f), true);
                        mass = 0.01f; break;
                    case "wrapper":
                    {
                        var tex = ProductTex("biscoff", "goldfish", "granola", "chip_bag");
                        g = MeshObject("wrapper", Crumpled(), Mat(tex != null ? Color.white : RandColor(0.6f, 1, 0.6f, 1), 0.6f, false, tex), true);
                        g.transform.localScale = new Vector3(0.13f, 0.03f, 0.09f);
                        mass = 0.008f; break;
                    }
                    case "utensil":
                        g = Prim(PrimitiveType.Cube, new Vector3(0.016f, 0.004f, 0.16f), Mat(Pick(new[] { Color.white, Color.black })), true);
                        mass = 0.004f; break;
                    case "napkin":
                        g = MeshObject("napkin", Crumpled(), Mat(Color.white * 0.97f), true);
                        g.transform.localScale = new Vector3(0.07f, 0.05f, 0.07f);
                        mass = 0.003f; break;
                    case "food":
                        g = Prim(PrimitiveType.Capsule, new Vector3(0.04f, 0.08f, 0.04f), Mat(Pick(new[] { new Color(0.95f, 0.8f, 0.2f), new Color(0.6f, 0.4f, 0.2f), new Color(0.8f, 0.2f, 0.2f) })), true);
                        mass = 0.1f; break;
                    case "sauce_cup":
                    {
                        var tex = ProductTex("sauce_cup");
                        g = MeshObject("sauce_cup", Frustum(0.022f, 0.03f, 0.035f), Mat(new Color(0.95f, 0.9f, 0.7f, 0.65f), 0.8f, true, tex), true);
                        mass = 0.03f; break;
                    }
                    default:
                        g = MeshObject("receipt", Crumpled(), Mat(Color.white * 0.93f), true);
                        g.transform.localScale = new Vector3(0.06f, 0.05f, 0.06f);
                        mass = 0.004f; break;
                }
                g.name = $"item_{items.Count}_{kind}";
                g.transform.localScale *= R(0.85f, 1.15f);
                var rb = g.AddComponent<Rigidbody>();
                rb.mass = mass; rb.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic; rb.isKinematic = true;
                rb.linearDamping = kind is "napkin" or "receipt" or "wrapper" or "paper" ? 0.8f : 0.05f;
                var it = new Item { Kind = kind, CatalogId = catalogId, Go = g, Rb = rb, Index = items.Count };
                items.Add(it);
                g.SetActive(false);
                return it;
            }

            // ---------------- scenarios (docs/sim/unity-sim-brief.md §4, v2) ----------------

            static readonly (string name, int weight)[] Scenarios =
            {
                ("clean", 21), ("multi_dump", 4), ("toss", 10), ("rim_in", 8), ("rim_out", 8), ("drop_next_to", 5), ("carried_away", 8),
                ("simultaneous", 6), ("passerby", 8), ("fast", 6), ("tiny", 5), ("lid_push", 4), ("floor_kick", 3), ("distractor", 4),
            };

            string PickScenario()
            {
                int total = Scenarios.Sum(s => s.weight), r = rng.Next(total);
                foreach (var (name, w) in Scenarios) { if (r < w) return name; r -= w; }
                return "clean";
            }

            void PlanThrows()
            {
                int n = rng.Next(2, 6); float t = 2.5f;
                for (int i = 0; i < n; i++)
                {
                    var sc = PickScenario();
                    if (sc == "lid_push" && !bins[0].Lid) sc = "clean"; // a lid_push slot without a lid stays a clean throw
                    int count = sc == "simultaneous" ? 2 : 1;
                    for (int k = 0; k < count; k++) AddThrow(sc, t);
                    t += R(4.5f, 7.5f);
                }
                duration = t + 3;
            }

            void AddThrow(string sc, float t)
            {
                var target = Pick(bins);
                var th = new Throw { Scenario = sc, Start = t, Target = target.Id, Person = Person(), RaiseHeight = R(0.12f, 0.25f) };
                int nItems = sc == "multi_dump" ? rng.Next(2, 4) : 1;
                for (int k = 0; k < nItems; k++)
                {
                    string kind = sc == "tiny" ? Pick(new[] { "utensil", "sauce_cup" }) : sc == "distractor" ? "receipt" : Kinds[rng.Next(Kinds.Length)];
                    var it = MakeItem(kind); it.Scenario = sc; it.IntendedBin = target.Id; th.Items.Add(it);
                }
                var opening = target.Center;
                th.From = new Vector3(R(-roomW / 2 + 0.6f, roomW / 2 - 0.6f), 0, R(-roomD / 2 + 0.6f, 0));
                float standOff = sc == "toss" ? R(1.0f, 2.0f) : R(0.45f, 0.75f);
                var away = new Vector3(th.From.x - opening.x, 0, th.From.z - opening.z);
                away = away.sqrMagnitude > 1e-4f ? away.normalized : Vector3.back;
                th.Stand = new Vector3(opening.x, 0, opening.z) + away * (standOff + target.Half);
                th.ReleaseAt = t + R(2.0f, 3.0f);
                th.CarryAway = sc is "carried_away" or "distractor";
                th.EndAt = th.ReleaseAt + (th.CarryAway ? 3f : 2f);
                foreach (var it in th.Items) it.ReleaseAt = th.ReleaseAt;
                throws.Add(th);
                if (sc == "floor_kick")
                {
                    var it = th.Items[0];
                    it.Go.SetActive(true);
                    it.Go.transform.position = new Vector3(opening.x + R(-0.6f, 0.6f), 0.05f, opening.z - target.Half - R(0.25f, 0.7f));
                    it.Rb.isKinematic = false;
                }
                if (sc == "passerby")
                {
                    var p = Person(); var z = (cam.transform.position.z + opening.z) / 2;
                    walkers.Add((p, new Vector3(-roomW / 2 - 0.5f, 0, z), new Vector3(roomW / 2 + 0.5f, 0, z), th.ReleaseAt - 1.2f, th.ReleaseAt + 2.0f, null));
                }
            }

            void PlanDistractors()
            {
                int n = rng.Next(0, 3); // people who only walk through, some carrying something they keep
                for (int i = 0; i < n; i++)
                {
                    float t0 = R(1, Mathf.Max(1.5f, duration - 4)), z = R(-roomD / 2 + 0.8f, roomD / 2 - 1.2f);
                    var carried = Chance(0.5) ? MakeItem(Pick(new[] { "bottle", "paper_cup", "wrapper" })) : null;
                    if (carried != null) { carried.Scenario = "walk_through"; carried.IntendedBin = "none"; }
                    float dirn = Chance(0.5) ? 1 : -1;
                    walkers.Add((Person(), new Vector3(-dirn * (roomW / 2 + 0.5f), 0, z), new Vector3(dirn * (roomW / 2 + 0.5f), 0, z), t0, t0 + R(3, 6), carried));
                }
                for (int i = 0; i < movers.Count; i++)
                {
                    var m = movers[i];
                    movers[i] = (m.go, m.a, m.b, m.t0, m.t0 + R(0.8f, 1.6f));
                }
            }

            Vector3 ReleaseVelocity(Throw th, Vector3 from, int k)
            {
                var bin = bins.First(b => b.Id == th.Target);
                var aim = bin.Center + new Vector3(0, bin.Height + 0.05f, 0);
                float flight = th.Scenario == "fast" ? R(0.12f, 0.2f) : th.Scenario == "toss" ? R(0.6f, 0.9f) : th.Scenario == "lid_push" ? R(0.35f, 0.5f) : R(0.25f, 0.45f);
                switch (th.Scenario)
                {
                    case "rim_in": aim += new Vector3(R(-1, 1), 0, R(-1, 1)).normalized * bin.Half * R(0.75f, 0.95f); break;
                    case "rim_out": aim += new Vector3(R(-1, 1), 0, R(-1, 1)).normalized * bin.Half * R(1.05f, 1.35f); break;
                    case "drop_next_to": aim += new Vector3(R(-1, 1), 0, R(-1, 1)).normalized * bin.Half * R(1.6f, 2.5f) - new Vector3(0, bin.Height, 0); break;
                    case "lid_push": aim += new Vector3(0, -0.15f, 0); break;
                    default: aim += new Vector3(R(-1, 1), 0, R(-1, 1)) * bin.Half * 0.4f + new Vector3(0, 0, k * 0.03f); break;
                }
                var d = aim - from;
                return new Vector3(d.x / flight, (d.y - 0.5f * Physics.gravity.y * flight * flight) / flight, d.z / flight);
            }

            // ---------------- simulation + capture ----------------

            readonly List<string> boxLines = new();

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
                    if (f % 3 == 0) boxLines.Add($"{f:D5}\t" + string.Join(";", Boxes()));
                }
                RenderTexture.active = null;
            }

            void Choreograph(float t)
            {
                foreach (var l in flicker) l.intensity = Mathf.PerlinNoise(t * 3f, seed % 1000) > 0.25f ? 1.2f : 0.25f;
                foreach (var m in movers)
                    if (t >= m.t0 && t <= m.t1) m.go.transform.position = Vector3.Lerp(m.a, m.b, (t - m.t0) / (m.t1 - m.t0));
                foreach (var th in throws)
                {
                    bool active = t >= th.Start && t <= th.EndAt + 1.5f;
                    th.Person.Root.SetActive(active);
                    foreach (var it in th.Items)
                    {
                        bool visible = th.Scenario == "floor_kick" || (t >= th.Start && (!th.CarryAway || t <= th.EndAt + 1.5f));
                        if (it.Go.activeSelf != visible) it.Go.SetActive(visible);
                    }
                    if (!active) continue;
                    var bin = bins.First(b => b.Id == th.Target);
                    float walkIn = Mathf.Clamp01((t - th.Start) / Mathf.Max(0.1f, th.ReleaseAt - 0.6f - th.Start));
                    Vector3 pos = Vector3.Lerp(th.From, th.Stand, walkIn);
                    bool walking = walkIn < 1;
                    Vector3 facing = walking ? th.Stand - th.From : bin.Center - th.Stand;
                    bool leaving = th.CarryAway && t > th.ReleaseAt + 0.8f;
                    if (leaving)
                    {
                        float back = Mathf.Clamp01((t - th.ReleaseAt - 0.8f) / 1.8f);
                        pos = Vector3.Lerp(th.Stand, th.From, back); walking = back < 1; facing = th.From - th.Stand;
                    }
                    float raise = Mathf.Clamp01((t - (th.ReleaseAt - 0.6f)) / 0.6f);
                    var handLow = HandPoint(th.Person, pos, facing, 1.0f, 0.15f);
                    var overBin = new Vector3(bin.Center.x, bin.Height + th.RaiseHeight, bin.Center.z);
                    var hand = leaving ? handLow : Vector3.Lerp(handLow, Vector3.Lerp(handLow, overBin, th.Scenario == "toss" ? 0.15f : 0.75f), raise);
                    if (th.Scenario == "floor_kick") hand = handLow;
                    Pose(th.Person, pos, facing, walking, hand, t);
                    if (th.Scenario == "floor_kick") continue;
                    if (!th.Released && (th.CarryAway || t < th.ReleaseAt))
                    {
                        for (int k = 0; k < th.Items.Count; k++)
                        {
                            th.Items[k].Rb.isKinematic = true;
                            th.Items[k].Go.transform.position = hand + new Vector3(0.03f * k, -0.04f - 0.03f * k, 0);
                        }
                    }
                    else if (!th.Released)
                    {
                        th.Released = true;
                        for (int k = 0; k < th.Items.Count; k++)
                        {
                            var it = th.Items[k];
                            it.Rb.isKinematic = false;
                            it.Rb.linearVelocity = ReleaseVelocity(th, it.Go.transform.position, k);
                            it.Rb.angularVelocity = new Vector3(R(-6, 6), R(-6, 6), R(-6, 6));
                        }
                    }
                }
                foreach (var w in walkers)
                {
                    bool on = t >= w.t0 && t <= w.t1;
                    w.body.Root.SetActive(on);
                    if (w.carried != null) w.carried.Go.SetActive(on);
                    if (!on) continue;
                    var p = Vector3.Lerp(w.a, w.b, (t - w.t0) / (w.t1 - w.t0));
                    var hand = HandPoint(w.body, p, w.b - w.a, 1.0f, 0.15f);
                    Pose(w.body, p, w.b - w.a, true, w.carried != null ? hand : (Vector3?)null, t);
                    if (w.carried != null) w.carried.Go.transform.position = hand + new Vector3(0, -0.04f, 0);
                }
            }

            void TrackGroundTruth(float t)
            {
                foreach (var it in items)
                {
                    if (it.LabeledBin != null) continue;
                    if (!it.Go.activeInHierarchy || it.Rb.isKinematic) { it.InsideSince = -1; continue; }
                    var p = it.Go.transform.position;
                    var inside = bins.FirstOrDefault(b => Mathf.Abs(p.x - b.Center.x) < b.Half && Mathf.Abs(p.z - b.Center.z) < b.Half && p.y < b.Height && p.y > 0);
                    if (inside == null) { it.InsideSince = -1; continue; }
                    if (it.InsideSince < 0) it.InsideSince = t;
                    if (t - it.InsideSince >= 0.5f) { it.LabeledBin = inside.Id; it.LabeledAt = it.InsideSince; }
                }
            }

            IEnumerable<string> Boxes()
            {
                var bodies = throws.Select(x => x.Person.Root).Concat(walkers.Select(w => w.body.Root)).Where(r => r.activeInHierarchy).Select(BoundsOf).ToList();
                foreach (var it in items)
                {
                    if (!it.Go.activeInHierarchy) continue;
                    var bnd = BoundsOf(it.Go);
                    if (!Visible(bnd, it.Go, bodies)) continue;
                    if (ScreenBox(bnd, out var b)) yield return string.Format(Inv, "0 {0:F5} {1:F5} {2:F5} {3:F5} {4} {5}", b.x, b.y, b.z, b.w, it.Index, it.Kind);
                }
                foreach (var body in throws.Select(x => x.Person).Concat(walkers.Select(w => w.body)))
                    if (body.Root.activeInHierarchy && ScreenBox(BoundsOf(body.Root), out var b))
                        yield return string.Format(Inv, "1 {0:F5} {1:F5} {2:F5} {3:F5} -1 person", b.x, b.y, b.z, b.w);
            }

            static Bounds BoundsOf(GameObject g)
            {
                var rs = g.GetComponentsInChildren<Renderer>();
                var b = rs[0].bounds;
                foreach (var r in rs.Skip(1)) b.Encapsulate(r.bounds);
                return b;
            }

            bool Visible(Bounds bnd, GameObject self, List<Bounds> bodies)
            {
                // share of 9 sample points with a clear line of sight; people have no colliders, so their
                // bounds are tested separately. >= 20% visible counts.
                int seen = 0, total = 0; var c = cam.transform.position;
                for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++)
                {
                    var p = bnd.center + Vector3.Scale(bnd.extents * 0.8f, new Vector3(i, j, i * j == 0 ? 1 : -1));
                    total++;
                    var ray = new Ray(c, p - c); float dist = (p - c).magnitude;
                    bool blocked = Physics.Raycast(ray, out var hit, dist - 0.02f) && !hit.collider.transform.IsChildOf(self.transform);
                    if (!blocked) blocked = bodies.Any(bb => bb.IntersectRay(ray, out var bd) && bd < dist - 0.05f && !bb.Contains(p));
                    if (!blocked) seen++;
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

            // ---------------- outputs (packed by sim/unity-mac/pack.py) ----------------

            void WriteOutputs()
            {
                string F(float v) => v.ToString("F4", Inv);
                string Q(string s) => s == null ? "null" : "\"" + s + "\"";
                var sb = new StringBuilder();
                sb.Append("{\"version\":\"").Append(Version).Append("\",\"seed\":").Append(seed).Append(",\"split\":\"").Append(split)
                  .Append("\",\"fps\":").Append(Fps).Append(",\"width\":").Append(W).Append(",\"height\":").Append(H)
                  .Append(",\"frames\":").Append(Mathf.CeilToInt(duration * Fps));
                foreach (var kv in config) sb.Append(",\"").Append(kv.Key).Append("\":\"").Append(kv.Value).Append('"');
                sb.Append(",\"bins\":[");
                sb.Append(string.Join(",", bins.Select(b =>
                {
                    float x0 = 1, y0 = 1, x1 = 0, y1 = 0;
                    int sides = b.Round ? 16 : 4;
                    for (int s = 0; s < sides; s++)
                    {
                        var off = b.Round ? new Vector3(Mathf.Cos(s * Mathf.PI * 2 / sides), 0, Mathf.Sin(s * Mathf.PI * 2 / sides)) * b.Half
                                          : new Vector3((s & 1) == 0 ? -b.Half : b.Half, 0, (s & 2) == 0 ? -b.Half : b.Half);
                        var v = cam.WorldToViewportPoint(b.Center + new Vector3(0, b.Height, 0) + off);
                        x0 = Mathf.Min(x0, v.x); x1 = Mathf.Max(x1, v.x); y0 = Mathf.Min(y0, 1 - v.y); y1 = Mathf.Max(y1, 1 - v.y);
                    }
                    x0 = Mathf.Clamp01(x0); x1 = Mathf.Clamp01(x1); y0 = Mathf.Clamp01(y0); y1 = Mathf.Clamp01(y1);
                    return "{\"bin_id\":\"" + b.Id + "\",\"type\":\"" + b.Type + "\",\"x\":" + F(x0) + ",\"y\":" + F(y0) + ",\"w\":" + F(x1 - x0) + ",\"h\":" + F(y1 - y0) + "}";
                })));
                sb.Append("],\"items\":[");
                sb.Append(string.Join(",", items.Select(it =>
                    "{\"index\":" + it.Index + ",\"kind\":\"" + it.Kind + "\",\"catalog_item_id\":" + Q(it.CatalogId) + ",\"scenario\":" + Q(it.Scenario)
                    + ",\"intended_bin\":" + Q(it.IntendedBin) + ",\"labeled_bin\":" + Q(it.LabeledBin)
                    + ",\"labeled_at\":" + it.LabeledAt.ToString("F3", Inv) + ",\"release_at\":" + it.ReleaseAt.ToString("F3", Inv) + "}")));
                sb.Append("]}");
                File.WriteAllText(Path.Combine(dir, "unity.json"), sb.ToString());
                File.WriteAllLines(Path.Combine(dir, "yolo_boxes.tsv"), boxLines);
            }
        }
    }
}
