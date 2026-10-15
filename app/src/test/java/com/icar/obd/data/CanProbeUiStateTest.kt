package com.icar.obd.data
import org.junit.Assert.*
import org.junit.Test
class CanProbeUiStateTest {
    private fun actions(phase: CanSnifferText.Phase = CanSnifferText.Phase.IDLE, busy: Boolean = false,
        active: Boolean = false, monitor: Boolean = false, connected: Boolean = true, valid: Boolean = true,
        frames: Boolean = true, baseline: Boolean = true) = CanProbeUiState.actions(phase,busy,active,monitor,connected,valid,frames,baseline)
    @Test fun `disconnected cannot claim capture or monitor started`() {
        val a=actions(connected=false); assertFalse(a.canStart); assertFalse(a.monitor); assertTrue(a.editSettings)
    }
    @Test fun `invalid filter prevents capture without blocking editing`() {
        val a=actions(valid=false); assertFalse(a.canStart); assertTrue(a.editSettings)
    }
    @Test fun `preparation and capture can stop but cannot reset export or change settings`() {
        for(p in listOf(CanSnifferText.Phase.PREPARING,CanSnifferText.Phase.CAPTURING)) {
            val a=actions(phase=p,busy=true); assertTrue(a.canStop); assertFalse(a.canStart)
            assertFalse(a.editSettings);assertFalse(a.clear);assertFalse(a.export);assertFalse(a.monitor)
        }
    }
    @Test fun `cleanup remains locked instead of enabling start too early`() {
        val a=actions(phase=CanSnifferText.Phase.FINISHING,busy=true)
        assertFalse(a.canStart);assertFalse(a.canStop);assertFalse(a.monitor);assertFalse(a.editSettings)
    }
    @Test fun `monitor running or finishing blocks probe and settings`() {
        val live=actions(active=true,monitor=true); assertFalse(live.canStart);assertFalse(live.editSettings);assertTrue(live.monitor)
        val finishing=actions(active=true,monitor=false);assertFalse(finishing.monitor);assertFalse(finishing.canStart)
    }
    @Test fun `no frames or no comparable baseline disables result actions`() {
        val a=actions(frames=false,baseline=false);assertFalse(a.clear);assertFalse(a.export);assertFalse(a.compare)
        assertFalse(actions(baseline=false).compare)
    }
}
