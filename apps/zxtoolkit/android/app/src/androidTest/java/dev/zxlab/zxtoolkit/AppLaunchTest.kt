package dev.zxlab.zxtoolkit

import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AppLaunchTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun unpairedLaunchShowsScanner() {
        compose.onNodeWithText("连接这台 Android").assertIsDisplayed()
    }

    @Test fun multipleShareIsRejected() {
        compose.activityRule.scenario.onActivity {
            it.startActivity(Intent(it, MainActivity::class.java).setAction(Intent.ACTION_SEND_MULTIPLE).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP))
        }
        compose.onNodeWithText("首版仅支持单个文件").assertIsDisplayed()
    }
}
