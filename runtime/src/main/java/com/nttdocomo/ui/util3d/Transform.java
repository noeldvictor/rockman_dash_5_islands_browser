package com.nttdocomo.ui.util3d;

/**
 * 4x4 matrix, row-major (element index = row * 4 + column; translation in 3, 7, 11). All
 * operations post-multiply: this = this * op. Angles are in degrees.
 */
public class Transform {
    public final float[] m = new float[16];

    public Transform() {
        setIdentity();
    }

    public Transform(Transform t) {
        set(t);
    }

    public void setIdentity() {
        for (int i = 0; i < 16; i++) {
            m[i] = (i % 5 == 0) ? 1f : 0f;
        }
    }

    public void set(Transform t) {
        System.arraycopy(t.m, 0, m, 0, 16);
    }

    public void set(float[] v) {
        System.arraycopy(v, 0, m, 0, 16);
    }

    public void get(float[] v) {
        System.arraycopy(m, 0, v, 0, 16);
    }

    public void set(int index, float v) {
        m[index] = v;
    }

    public float get(int index) {
        return m[index];
    }

    public void transpose() {
        for (int r = 0; r < 4; r++) {
            for (int c = r + 1; c < 4; c++) {
                float t = m[r * 4 + c];
                m[r * 4 + c] = m[c * 4 + r];
                m[c * 4 + r] = t;
            }
        }
    }

    public void invert() {
        float[] a = m;
        float a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
        float a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
        float a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
        float a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
        float b00 = a00 * a11 - a01 * a10;
        float b01 = a00 * a12 - a02 * a10;
        float b02 = a00 * a13 - a03 * a10;
        float b03 = a01 * a12 - a02 * a11;
        float b04 = a01 * a13 - a03 * a11;
        float b05 = a02 * a13 - a03 * a12;
        float b06 = a20 * a31 - a21 * a30;
        float b07 = a20 * a32 - a22 * a30;
        float b08 = a20 * a33 - a23 * a30;
        float b09 = a21 * a32 - a22 * a31;
        float b10 = a21 * a33 - a23 * a31;
        float b11 = a22 * a33 - a23 * a32;
        float det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        if (det == 0f) {
            throw new ArithmeticException("singular matrix");
        }
        float d = 1f / det;
        a[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
        a[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
        a[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
        a[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
        a[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
        a[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
        a[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
        a[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
        a[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
        a[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
        a[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
        a[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
        a[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
        a[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
        a[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
        a[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
    }

    public void multiply(Transform t) {
        mul(t.m);
    }

    private void mul(float[] b) {
        float[] a = m;
        for (int r = 0; r < 4; r++) {
            int o = r * 4;
            float a0 = a[o], a1 = a[o + 1], a2 = a[o + 2], a3 = a[o + 3];
            a[o] = a0 * b[0] + a1 * b[4] + a2 * b[8] + a3 * b[12];
            a[o + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9] + a3 * b[13];
            a[o + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10] + a3 * b[14];
            a[o + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3 * b[15];
        }
    }

    public void scale(float sx, float sy, float sz) {
        float[] a = m;
        for (int r = 0; r < 4; r++) {
            a[r * 4] *= sx;
            a[r * 4 + 1] *= sy;
            a[r * 4 + 2] *= sz;
        }
    }

    public void scale(Vector3D v) {
        scale(v.x, v.y, v.z);
    }

    public void translate(float x, float y, float z) {
        float[] a = m;
        for (int r = 0; r < 4; r++) {
            int o = r * 4;
            a[o + 3] += a[o] * x + a[o + 1] * y + a[o + 2] * z;
        }
    }

    public void translate(Vector3D v) {
        translate(v.x, v.y, v.z);
    }

    public void rotate(float x, float y, float z, float angle) {
        float len = (float) Math.sqrt(x * x + y * y + z * z);
        if (len == 0f) {
            return;
        }
        x /= len;
        y /= len;
        z /= len;
        double rad = angle * Math.PI / 180.0;
        float c = (float) Math.cos(rad);
        float s = (float) Math.sin(rad);
        float t = 1f - c;
        float[] r = {
            t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0f,
            t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0f,
            t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0f,
            0f, 0f, 0f, 1f,
        };
        mul(r);
    }

    public void rotate(Vector3D axis, float angle) {
        rotate(axis.x, axis.y, axis.z, angle);
    }

    public void rotateQuat(float x, float y, float z, float w) {
        float len = (float) Math.sqrt(x * x + y * y + z * z + w * w);
        if (len == 0f) {
            return;
        }
        x /= len;
        y /= len;
        z /= len;
        w /= len;
        float[] r = {
            1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0f,
            2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0f,
            2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0f,
            0f, 0f, 0f, 1f,
        };
        mul(r);
    }

    public void rotateQuat(Vector3D v, float w) {
        rotateQuat(v.x, v.y, v.z, w);
    }

    /**
     * Sets this to the view matrix of a camera at {@code position} looking at the point
     * {@code look}. View space is x right, y up, +z forward.
     */
    public void lookAt(Vector3D position, Vector3D look, Vector3D up) {
        float zx = look.x - position.x, zy = look.y - position.y, zz = look.z - position.z;
        float zl = (float) Math.sqrt(zx * zx + zy * zy + zz * zz);
        if (zl == 0f) {
            return;
        }
        zx /= zl;
        zy /= zl;
        zz /= zl;
        float xx = up.y * zz - up.z * zy, xy = up.z * zx - up.x * zz, xz = up.x * zy - up.y * zx;
        float xl = (float) Math.sqrt(xx * xx + xy * xy + xz * xz);
        if (xl == 0f) {
            return;
        }
        xx /= xl;
        xy /= xl;
        xz /= xl;
        float yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
        float[] a = m;
        a[0] = xx; a[1] = xy; a[2] = xz; a[3] = -(xx * position.x + xy * position.y + xz * position.z);
        a[4] = yx; a[5] = yy; a[6] = yz; a[7] = -(yx * position.x + yy * position.y + yz * position.z);
        a[8] = zx; a[9] = zy; a[10] = zz; a[11] = -(zx * position.x + zy * position.y + zz * position.z);
        a[12] = 0f; a[13] = 0f; a[14] = 0f; a[15] = 1f;
    }

    public void transVector(Vector3D src, Vector3D dst) {
        float[] a = m;
        float x = src.x, y = src.y, z = src.z;
        dst.set(a[0] * x + a[1] * y + a[2] * z + a[3],
                a[4] * x + a[5] * y + a[6] * z + a[7],
                a[8] * x + a[9] * y + a[10] * z + a[11]);
    }
}
