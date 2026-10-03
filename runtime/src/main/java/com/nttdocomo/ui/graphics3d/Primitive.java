package com.nttdocomo.ui.graphics3d;

import rdash.Host;

/**
 * Immediate-mode geometry. The game writes straight into the int arrays returned by the getters
 * every frame; the host object holds views onto the very same arrays.
 */
public class Primitive extends DrawableObject3D {
    public static final int PRIMITIVE_POINTS = 1;
    public static final int PRIMITIVE_LINES = 2;
    public static final int PRIMITIVE_TRIANGLES = 3;
    public static final int PRIMITIVE_QUADS = 4;
    public static final int PRIMITIVE_POINT_SPRITES = 5;
    public static final int NORMAL_NONE = 0;
    public static final int NORMAL_PER_FACE = 512;
    public static final int NORMAL_PER_VERTEX = 768;
    public static final int COLOR_NONE = 0;
    public static final int COLOR_PER_PRIMITIVE = 1024;
    public static final int COLOR_PER_FACE = 2048;
    public static final int TEXTURE_COORD_NONE = 0;
    public static final int TEXTURE_COORD_PER_VERTEX = 12288;
    public static final int TEXTURE_COLORKEY = 16;
    public static final int POINT_SPRITE_PER_PRIMITIVE = 4096;
    public static final int POINT_SPRITE_PER_VERTEX = 12288;

    private final int type;
    private final int param;
    private final int size;
    private final int[] vertices;
    private final int[] normals;
    private final int[] colors;
    private final int[] texCoords;
    private final int[] pointSprites;

    public Primitive(int type, int param, int size) {
        super(TYPE_PRIMITIVE);
        if (type < PRIMITIVE_POINTS || type > PRIMITIVE_POINT_SPRITES || size <= 0) {
            throw new IllegalArgumentException();
        }
        this.type = type;
        this.param = param;
        this.size = size;
        int perFace = type == PRIMITIVE_POINT_SPRITES ? 1 : type;
        vertices = new int[size * perFace * 3];
        int normal = param & 0x300;
        normals = normal == NORMAL_PER_FACE ? new int[size * 3]
                : normal == NORMAL_PER_VERTEX ? new int[size * perFace * 3] : null;
        int color = param & 0xC00;
        colors = color == COLOR_PER_PRIMITIVE ? new int[1] : color == COLOR_PER_FACE ? new int[size] : null;
        int tex = param & 0x3000;
        if (type == PRIMITIVE_POINT_SPRITES) {
            texCoords = null;
            pointSprites = tex == POINT_SPRITE_PER_PRIMITIVE ? new int[8]
                    : tex == POINT_SPRITE_PER_VERTEX ? new int[size * 8] : null;
        } else {
            texCoords = tex == TEXTURE_COORD_PER_VERTEX ? new int[size * perFace * 2] : null;
            pointSprites = null;
        }
        js = Host.g3dCreatePrimitive(type, param, size);
        Host.g3dPrimitiveArray(js, "vertices", vertices);
        if (normals != null) {
            Host.g3dPrimitiveArray(js, "normals", normals);
        }
        if (colors != null) {
            Host.g3dPrimitiveArray(js, "colors", colors);
        }
        if (texCoords != null) {
            Host.g3dPrimitiveArray(js, "texCoords", texCoords);
        }
        if (pointSprites != null) {
            Host.g3dPrimitiveArray(js, "pointSprites", pointSprites);
        }
    }

    public int getPrimitiveType() {
        return type;
    }

    public int getPrimitiveParam() {
        return param;
    }

    public int size() {
        return size;
    }

    public int[] getVertexArray() {
        return vertices;
    }

    public int[] getNormalArray() {
        return normals;
    }

    public int[] getColorArray() {
        return colors;
    }

    public int[] getTextureCoordArray() {
        return texCoords;
    }

    public int[] getPointSpriteArray() {
        return pointSprites;
    }

    public void setTexture(Texture t) {
        Host.g3dSetObject(js, "texture", t == null ? null : t.js);
    }
}
