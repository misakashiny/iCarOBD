plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.icar.obd"
    compileSdk = 35

    // LVGL 需要 NDK 编译。版本必须与 SDK 里实际装的一致，否则 AGP 会去下载另一个版本
    ndkVersion = "29.0.14206865"

    defaultConfig {
        applicationId = "com.icar.obd"
        minSdk = 24
        targetSdk = 34
        versionCode = 86
        versionName = "1.20.17"

        ndk {
            // 只编 arm64：LVGL 有 192 个 .c 文件，多一个 ABI 编译时间翻倍。
            // 需要 32 位设备时再加 "armeabi-v7a"。
            abiFilters += "arm64-v8a"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    androidResources {
        localeFilters += listOf("zh", "en")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    // LVGL（C）通过 CMake 编成 libicarobd_lvgl.so
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.31.6"
        }
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    // 多画布（v1.20.0）：仪表盘页改成 ViewPager2 —— [画布0][画布1]…[设置]。
    // 横滑翻页、页码变化即切 activeCanvasId（见 ui/DashFragment.kt）。
    // 1.1.0 是稳定版；1.0.0 在 FragmentStateAdapter 的稳定 id 处理上有已知毛病。
    implementation("androidx.viewpager2:viewpager2:1.1.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-service:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    testImplementation("junit:junit:4.13.2")
    // Android 的 org.json 在 JVM 单测里只是会抛 "Stub!" 的桩，导致 toJson/fromJson
    // 完全测不了 —— 而布局迁移的正确性恰恰依赖 JSON 往返。
    // 放一份真实实现到测试 classpath（排在 mockable android.jar 之前）即可。
    testImplementation("org.json:json:20231013")
}