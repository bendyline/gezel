package com.bendyline.gezel.runtime;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Admission after ML Kit has counted its fully serialized request; no model download or generation. */
@RunWith(AndroidJUnit4.class)
public final class SystemProviderBudgetTest {
    @Test public void countedPromptHonorsBothRequestedAndAvailableContext() {
        MlKitPrompt.requireContextBudget(500, 100, 1024, 4096);
        assertThrows(IllegalArgumentException.class, () -> MlKitPrompt.requireContextBudget(500, 100, 512, 4096));
        assertThrows(IllegalArgumentException.class, () -> MlKitPrompt.requireContextBudget(500, 100, 1024, 512));
        MlKitPrompt.requireContextBudget(512, 512, 1024, 4096);
        assertThrows(IllegalArgumentException.class, () -> MlKitPrompt.requireContextBudget(513, 512, 1024, 4096));
        assertThrows(IllegalArgumentException.class, () -> MlKitPrompt.requireContextBudget(-1, 100, 1024, 4096));
    }
}
