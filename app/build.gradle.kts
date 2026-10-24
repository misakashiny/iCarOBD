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
        versionCode = 91
        versionName = "1.20.22"

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
            // ============================================================
            // P5B-M05：**让 Release 变体可以被安装验证**（默认仍然是 unsigned）
            //
            // ## 为什么需要这个开关
            //
            // P5B-M03 / M04 的报告都记录了「Release APK 6,155,333 B」，但那些
            // 数字**都只是文件大小** —— Release 从来没有被真正安装过。
            // P5B-M05 阶段 A 一装就露馅：
            //
            //   INSTALL_PARSE_FAILED_NO_CERTIFICATES:
            //   Failed to collect certificates from base.apk
            //
            // 也就是「Release 能不能跑」这件事**从未被验证**。
            // 六种 v3 能力全都在 Release 里（dexdump 已证实），但没装上去跑过。
            //
            // ## 为什么不直接配一个正式签名
            //
            // 正式签名的 keystore / 口令属于**发布决策**，不是本任务授权范围。
            // 而且把签名材料写进仓库是安全事故。
            //
            // ## 做法
            //
            // 用 Gradle **自动生成的 debug keystore** 签 release 变体，
            // 只在显式加 `-Pp5b05ReleaseSigning=debug` 时生效。
            // 这样：
            //   · 默认 `assembleRelease` 输出**仍是 unsigned**（发布流程不受影响）
            //   · 验证时用一个标准签名的包，能装能跑
            //   · 产物名带 `-p5b05test` 后缀，肉眼可辨，不会与正式包混淆
            // ============================================================
            if (project.hasProperty("p5b05ReleaseSigning")) {
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }

    // 验证用产物改名，避免与正式发布包混淆
    applicationVariants.all {
        val v = this
        if (v.buildType.name == "release" && project.hasProperty("p5b05ReleaseSigning")) {
            v.outputs.all {
                (this as com.android.build.gradle.internal.api.BaseVariantOutputImpl)
                    .outputFileName = "app-release-p5b05test.apk"
            }
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