package com.nttdocomo.ui.graphics3d;

import java.io.IOException;
import java.io.InputStream;

import org.teavm.jso.JSObject;

import rdash.Host;
import rdash.Streams;

/** Base of all 3D resources. The actual data lives in the JS host object {@link #js}. */
public abstract class Object3D {
    public static final int TYPE_NONE = 0;
    public static final int TYPE_ACTION_TABLE = 1;
    public static final int TYPE_FIGURE = 2;
    public static final int TYPE_TEXTURE = 3;
    public static final int TYPE_FOG = 4;
    public static final int TYPE_LIGHT = 5;
    public static final int TYPE_PRIMITIVE = 6;
    public static final int TYPE_GROUP = 7;
    public static final int TYPE_GROUP_MESH = 8;

    public JSObject js;
    private final int type;
    private int time;

    Object3D() {
        this(TYPE_NONE);
    }

    Object3D(int type) {
        this.type = type;
    }

    public static Object3D createInstance(InputStream in) throws IOException {
        return createInstance(Streams.readAll(in));
    }

    public static Object3D createInstance(byte[] data) {
        if (data == null) {
            throw new NullPointerException();
        }
        JSObject js = Host.g3dCreate(data, data.length);
        Object3D o;
        switch (Host.g3dType(js)) {
            case TYPE_ACTION_TABLE: o = new ActionTable(); break;
            case TYPE_FIGURE: o = new Figure(); break;
            case TYPE_TEXTURE: o = new Texture(); break;
            case TYPE_GROUP: o = new Group(TYPE_GROUP); break;
            case TYPE_GROUP_MESH: o = new Group(TYPE_GROUP_MESH); break;
            default: throw new IllegalArgumentException("unsupported 3D data");
        }
        o.js = js;
        return o;
    }

    public void dispose() {
        if (js != null) {
            Host.g3dDispose(js);
            js = null;
        }
    }

    public int getType() {
        return type;
    }

    public void setTime(int time) {
        this.time = time;
        if (js != null) {
            Host.g3dSetTime(js, time);
        }
    }

    public int getTime() {
        return time;
    }
}
