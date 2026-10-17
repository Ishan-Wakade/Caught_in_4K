using System.IO;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Recyclone
{
    // Proves batchmode can build a scene from code and render a frame to PNG on this Mac.
    public static class SmokeRender
    {
        public static void Run()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene);
            var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
            cube.transform.rotation = Quaternion.Euler(20, 35, 0);
            var light = new GameObject("Light").AddComponent<Light>();
            light.type = LightType.Directional;
            light.transform.rotation = Quaternion.Euler(50, -30, 0);
            var cam = new GameObject("Camera").AddComponent<Camera>();
            cam.transform.position = new Vector3(0, 1, -4);
            cam.transform.LookAt(cube.transform);
            cam.backgroundColor = new Color(0.8f, 0.82f, 0.85f);
            cam.clearFlags = CameraClearFlags.SolidColor;

            var rt = new RenderTexture(640, 360, 24);
            cam.targetTexture = rt;
            cam.Render();
            RenderTexture.active = rt;
            var tex = new Texture2D(640, 360, TextureFormat.RGB24, false);
            tex.ReadPixels(new Rect(0, 0, 640, 360), 0, 0);
            tex.Apply();
            Directory.CreateDirectory("Output");
            File.WriteAllBytes("Output/smoke.png", tex.EncodeToPNG());
            Debug.Log("SMOKE_RENDER_OK " + Path.GetFullPath("Output/smoke.png"));
        }
    }
}
