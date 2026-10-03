package com.nttdocomo.ui.util3d;

public class Vector3D {
    public float x;
    public float y;
    public float z;

    public Vector3D() {
    }

    public Vector3D(Vector3D v) {
        set(v);
    }

    public Vector3D(float x, float y, float z) {
        set(x, y, z);
    }

    public void set(float x, float y, float z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    public void set(Vector3D v) {
        x = v.x;
        y = v.y;
        z = v.z;
    }

    public void add(float x, float y, float z) {
        this.x += x;
        this.y += y;
        this.z += z;
    }

    public void add(Vector3D v) {
        x += v.x;
        y += v.y;
        z += v.z;
    }

    public void setX(float x) {
        this.x = x;
    }

    public void setY(float y) {
        this.y = y;
    }

    public void setZ(float z) {
        this.z = z;
    }

    public float getX() {
        return x;
    }

    public float getY() {
        return y;
    }

    public float getZ() {
        return z;
    }

    public void normalize() {
        float len = (float) Math.sqrt(x * x + y * y + z * z);
        if (len > 0f) {
            x /= len;
            y /= len;
            z /= len;
        }
    }

    public float dot(Vector3D v) {
        return x * v.x + y * v.y + z * v.z;
    }

    public static float dot(Vector3D a, Vector3D b) {
        return a.x * b.x + a.y * b.y + a.z * b.z;
    }

    public void cross(Vector3D v) {
        cross(this, v);
    }

    public void cross(Vector3D a, Vector3D b) {
        float cx = a.y * b.z - a.z * b.y;
        float cy = a.z * b.x - a.x * b.z;
        float cz = a.x * b.y - a.y * b.x;
        x = cx;
        y = cy;
        z = cz;
    }
}
