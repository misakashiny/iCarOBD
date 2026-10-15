package com.icar.obd.obd
import org.junit.Assert.*
import org.junit.Test
class CanAdapterGateTest {
    @Test fun `initialization only enters a free adapter and old completion cannot release new owner`() {
        assertNull(CanAdapterGate.beginInitialization { true })
        val first=CanAdapterGate.beginInitialization { false }!!
        try {
            assertTrue(CanAdapterGate.initializing)
            assertNull(CanAdapterGate.beginInitialization { false })
            CanAdapterGate.endInitialization(first)
            val second=CanAdapterGate.beginInitialization { false }!!
            try {CanAdapterGate.endInitialization(first);assertTrue(CanAdapterGate.initializing)}
            finally {CanAdapterGate.endInitialization(second)}
        } finally {CanAdapterGate.endInitialization(first)}
        assertFalse(CanAdapterGate.initializing)
    }
}
