package app.rdash;

import android.app.Activity;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/**
 * The whole app: a full-screen WebView showing the game's web build, which is stored in the
 * APK's assets under www/.
 *
 * The page is not opened as a file: every request to https://rdash.app/ is answered from the
 * assets (shouldInterceptRequest), so the page has an ordinary secure origin. That is what makes
 * its saves (IndexedDB), module scripts and audio worklet behave as they do in a browser.
 * Nothing is fetched from the network; any other address is refused.
 */
public class MainActivity extends Activity {
    private static final String HOST = "rdash.app";
    // app: fill the screen; touch: show the on-screen controls (they hide while a controller is present)
    private static final String START = "https://" + HOST + "/index.html?app&touch";
    private static final Map<String, String> TYPES = new HashMap<>();

    static {
        TYPES.put("html", "text/html");
        TYPES.put("js", "text/javascript");
        TYPES.put("mjs", "text/javascript");
        TYPES.put("css", "text/css");
        TYPES.put("json", "application/json");
        TYPES.put("png", "image/png");
        TYPES.put("jpg", "image/jpeg");
        TYPES.put("glb", "model/gltf-binary");
    }

    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            // use the whole screen, including the strip beside a camera cut-out
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        // the system would otherwise paint its own (black) strips where the bars were
        getWindow().setStatusBarColor(0);
        getWindow().setNavigationBarColor(0);
        if (Build.VERSION.SDK_INT >= 29) {
            getWindow().setNavigationBarContrastEnforced(false);
            getWindow().setStatusBarContrastEnforced(false);
        }
        // lets a computer connected by USB inspect the page (chrome://inspect); nothing else can
        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        web.setBackgroundColor(0xff000000);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return answer(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost()); // never leave the game
            }
        });
        setContentView(web);
        hideSystemBars();
        web.requestFocus();
        if (state == null) {
            web.loadUrl(START);
        } else {
            web.restoreState(state);
        }
    }

    /** The asset for a URL of the game's origin, a 404 for anything it lacks, and a refusal for the rest. */
    private WebResourceResponse answer(Uri url) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        if (!HOST.equals(url.getHost())) {
            return new WebResourceResponse("text/plain", "utf-8", 403, "Offline", headers, new ByteArrayInputStream(new byte[0]));
        }
        String path = url.getPath();
        if (path == null || path.isEmpty() || path.equals("/")) {
            path = "/index.html";
        }
        String extension = path.substring(path.lastIndexOf('.') + 1).toLowerCase();
        String type = TYPES.get(extension);
        boolean text = type != null && (type.startsWith("text/") || type.endsWith("json"));
        try {
            return new WebResourceResponse(type != null ? type : "application/octet-stream", text ? "utf-8" : null,
                    200, "OK", headers, getAssets().open("www" + path));
        } catch (IOException missing) {
            // optional packs (sampled instruments, AI textures, Legends 2 models) are probed this way
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, new ByteArrayInputStream(new byte[0]));
        }
    }

    @Override
    public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) {
            hideSystemBars();
            web.requestFocus();
        }
    }

    /** Full screen: no status or navigation bar; a swipe from the edge shows them briefly. */
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // A controller's B button doubles as "back" when nothing handles it: the game does.
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK
                && (event.getSource() & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD) {
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onBackPressed() {
        moveTaskToBack(true); // leave the game running; saves are written by the game itself
    }

    @Override
    protected void onPause() {
        web.onPause();
        web.pauseTimers();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.resumeTimers();
        web.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        web.saveState(state);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
