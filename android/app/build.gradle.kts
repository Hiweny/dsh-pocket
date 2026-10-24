plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.hiweny.dshpocket"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.hiweny.dshpocket"
        minSdk = 24
        targetSdk = 34
        versionCode = (System.getenv("DSH_VERSION_CODE") ?: "1").toIntOrNull() ?: 1
        versionName = System.getenv("DSH_VERSION_NAME") ?: "1.0.0"
    }

    signingConfigs {
        create("release") {
            val ks = System.getenv("DSH_KEYSTORE")
            if (!ks.isNullOrBlank()) {
                storeFile = file(ks)
                storePassword = System.getenv("DSH_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("DSH_KEY_ALIAS")
                keyPassword = System.getenv("DSH_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // 壳工程本身很小，不做混淆：避免 WebView JS 桥 / 反射被误伤，
            // 也保证崩溃栈可读。
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (!System.getenv("DSH_KEYSTORE").isNullOrBlank()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }

    lint {
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
